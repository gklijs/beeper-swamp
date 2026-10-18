/**
 * Beeper Desktop behavior for swamp.
 *
 * Talks to the Beeper Desktop local HTTP API (default
 * `http://127.0.0.1:23373`) to probe account health, list chats, read recent
 * messages, send a message, and inspect the access token. Use it to deliver
 * workflow alerts into any chat Beeper bridges (WhatsApp, Signal, Telegram,
 * iMessage, and more) or to pull cross-network message history into a repo.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Default Beeper Desktop API base URL. */
const DEFAULT_BASE_URL = "http://127.0.0.1:23373";

/** Per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Maximum number of retries when the API answers 429. */
const MAX_THROTTLE_RETRIES = 2;

/** Global arguments accepted by every Beeper method. */
const BeeperGlobalArgsSchema = z.object({
  baseUrl: z
    .url()
    .default(DEFAULT_BASE_URL)
    .describe(
      "Base URL of the Beeper Desktop API. Defaults to http://127.0.0.1:23373. " +
        "When running under WSL2 use the Windows host IP or enable WSL mirrored networking.",
    ),
  accessToken: z
    .string()
    .min(1)
    .meta({ sensitive: true })
    .describe(
      "Beeper Desktop access token (Beeper Desktop -> Settings -> Developers -> Access token).",
    ),
  defaultChatID: z
    .string()
    .min(1)
    .optional()
    .describe("Chat ID used by methods whose arguments omit chatID."),
});

/** Resolved global arguments. */
type BeeperGlobalArgs = z.infer<typeof BeeperGlobalArgsSchema>;

/** One connected account as reported by the Beeper API. */
const AccountSchema = z.object({
  accountID: z.string(),
  network: z.string(),
  status: z.string(),
});

/** One chat summary as reported by the Beeper API. */
const ChatSchema = z.object({
  id: z.string(),
  localChatID: z.string().optional(),
  accountID: z.string(),
  network: z.string(),
  title: z.string().optional(),
  type: z.string().optional(),
  unreadCount: z.number().int(),
  isMuted: z.boolean(),
  isArchived: z.boolean(),
  lastActivity: z.string().optional(),
});

/** One message as reported by the Beeper API. */
const MessageSchema = z.object({
  id: z.string(),
  senderID: z.string(),
  senderName: z.string().optional(),
  timestamp: z.string(),
  text: z.string().optional(),
  type: z.string().optional(),
  isSender: z.boolean(),
  isDeleted: z.boolean(),
  isHidden: z.boolean(),
  linkedMessageID: z.string().optional(),
});

/** Output of the `health` method. */
const HealthSchema = z.object({
  ok: z.boolean(),
  baseUrl: z.string(),
  latencyMs: z.number().int(),
  accountCount: z.number().int(),
  connectedCount: z.number().int(),
  degraded: z.boolean(),
  accounts: z.array(AccountSchema),
  checkedAt: z.string(),
});

/** Output of the `listChats` method. */
const ChatsSchema = z.object({
  chats: z.array(ChatSchema),
  count: z.number().int(),
  truncated: z.boolean(),
  oldestCursor: z.string().optional(),
  newestCursor: z.string().optional(),
  fetchedAt: z.string(),
});

/** Output of the `listMessages` method. */
const MessagesSchema = z.object({
  chatID: z.string(),
  messages: z.array(MessageSchema),
  count: z.number().int(),
  truncated: z.boolean(),
  oldestCursor: z.string().optional(),
  newestCursor: z.string().optional(),
  fetchedAt: z.string(),
});

/** Output of the `sendMessage` method. */
const SentMessageSchema = z.object({
  chatID: z.string(),
  pendingMessageID: z.string(),
  text: z.string(),
  replyToMessageID: z.string().optional(),
  sentAt: z.string(),
});

/** Output of the `checkToken` method. */
const TokenSchema = z.object({
  active: z.boolean(),
  tokenType: z.string().optional(),
  scope: z.string().optional(),
  clientID: z.string().optional(),
  issuedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  expiresInSeconds: z.number().optional(),
  checkedAt: z.string(),
});

/** Arguments for `listChats`. */
const ListChatsArgsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(100).describe(
    "Chats per page (Beeper maximum is 200).",
  ),
  maxChats: z.number().int().min(1).max(5_000).default(500).describe(
    "Overall cap across pages; sets `truncated` when reached.",
  ),
  accountIDs: z.array(z.string().min(1)).optional().describe(
    "Limit to specific account IDs.",
  ),
  cursor: z.string().optional().describe("Opaque pagination cursor."),
  direction: z.enum(["after", "before"]).optional().describe(
    "Pagination direction used with `cursor`.",
  ),
});

/** Arguments for `listMessages`. */
const ListMessagesArgsSchema = z.object({
  chatID: z.string().min(1).optional().describe(
    "Chat to read; falls back to globalArguments.defaultChatID.",
  ),
  maxMessages: z.number().int().min(1).max(2_000).default(50).describe(
    "Overall cap across pages; sets `truncated` when reached.",
  ),
  cursor: z.string().optional().describe("Opaque pagination cursor."),
  direction: z.enum(["after", "before"]).optional().describe(
    "Pagination direction used with `cursor`.",
  ),
});

/** Arguments for `sendMessage`. */
const SendMessageArgsSchema = z.object({
  chatID: z.string().min(1).optional().describe(
    "Destination chat; falls back to globalArguments.defaultChatID.",
  ),
  text: z.string().min(1).describe("Message body."),
  replyToMessageID: z.string().min(1).optional().describe(
    "Message ID to reply to.",
  ),
});

/** HTTP options for one Beeper request. */
interface BeeperRequestOptions {
  method: "GET" | "POST";
  body?: string;
  contentType?: string;
  retryOnThrottle?: boolean;
}

/** Minimal shape shared by the Beeper list envelopes. */
interface BeeperListEnvelope {
  items: Record<string, unknown>[];
  hasMore: boolean;
  oldestCursor?: string;
  newestCursor?: string;
}

/**
 * Normalize a thrown value into a message string.
 *
 * @param error - The caught value.
 * @returns A human-readable message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Truncate long text for inclusion in error messages.
 *
 * @param text - Input text.
 * @param max - Maximum length.
 * @returns The possibly-truncated text.
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * Build a descriptive error string for a non-ok HTTP response.
 *
 * @param status - HTTP status code.
 * @param path - Request path.
 * @param body - Response body.
 * @returns A descriptive message.
 */
function httpError(status: number, path: string, body: string): string {
  const detail = truncate(body, 300);
  if (status === 401) {
    return `Beeper Desktop API rejected the access token (HTTP 401) for ${path}. ` +
      "Check globalArguments.accessToken and that it is enabled in Beeper Desktop -> Settings -> Developers.";
  }
  if (status === 404) {
    return `Beeper Desktop API returned 404 for ${path}. Check the chat ID. Response: ${detail}`;
  }
  if (status >= 500) {
    return `Beeper Desktop API returned ${status} for ${path} (transient). Response: ${detail}`;
  }
  return `Beeper Desktop API returned ${status} for ${path}. Response: ${detail}`;
}

/**
 * Sleep for a duration, aborting early if the signal fires.
 *
 * @param ms - Milliseconds to wait.
 * @param signal - Optional abort signal.
 * @returns A promise that resolves after the delay.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted while waiting to retry a Beeper request"));
    }, { once: true });
  });
}

/**
 * Perform an authenticated request against the Beeper Desktop API.
 *
 * @param globalArgs - Resolved global arguments (base URL and token).
 * @param path - Path beginning with `/`.
 * @param options - Method, body and retry behaviour.
 * @param signal - Optional abort signal from the method context.
 * @returns Parsed JSON, or `null` for an empty body.
 */
async function beeperRequest(
  globalArgs: BeeperGlobalArgs,
  path: string,
  options: BeeperRequestOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = `${globalArgs.baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${globalArgs.accessToken}`,
    "Accept": "application/json",
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = options.contentType ?? "application/json";
  }

  for (let attempt = 0;; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new Error(
        `Beeper request to ${path} failed: ${errorMessage(error)}. ` +
          `Is Beeper Desktop running and ${globalArgs.baseUrl} reachable?`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (
      response.status === 429 && options.retryOnThrottle &&
      attempt < MAX_THROTTLE_RETRIES
    ) {
      const retryAfter = Number.parseInt(
        response.headers.get("Retry-After") ?? "",
        10,
      );
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * (attempt + 1);
      await sleep(waitMs, signal);
      continue;
    }

    if (!response.ok) {
      throw new Error(httpError(response.status, path, text));
    }
    if (text.length === 0) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `Beeper returned ${response.status} with a non-JSON body for ${path}: ${
          truncate(text, 200)
        }`,
      );
    }
  }
}

/**
 * Narrow an unknown value to a plain object.
 *
 * @param value - The value to inspect.
 * @returns The object, or `null` when not a plain object.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Read a string field from a record.
 *
 * @param source - Source record.
 * @param key - Field name.
 * @returns The string value, or `undefined`.
 */
function readString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Read an integer field from a record.
 *
 * @param source - Source record.
 * @param key - Field name.
 * @returns The integer value, or `undefined`.
 */
function readInt(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

/**
 * Read a boolean field from a record, defaulting to `false`.
 *
 * @param source - Source record.
 * @param key - Field name.
 * @returns The boolean value.
 */
function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

/**
 * Parse the `{ items, hasMore, ... }` envelope returned by Beeper list routes.
 *
 * @param payload - Parsed JSON body.
 * @param path - Request path, used in error messages.
 * @returns The normalized envelope.
 */
function asListEnvelope(payload: unknown, path: string): BeeperListEnvelope {
  const record = asRecord(payload);
  const rawItems = record?.items;
  if (!record || !Array.isArray(rawItems)) {
    throw new Error(
      `Beeper returned an unexpected body for ${path}: expected an object with an "items" array.`,
    );
  }
  const items = rawItems
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
  return {
    items,
    hasMore: readBoolean(record, "hasMore"),
    oldestCursor: readString(record, "oldestCursor"),
    newestCursor: readString(record, "newestCursor"),
  };
}

/**
 * Derive a storage-safe instance name from a chat ID.
 *
 * @param chatID - Raw chat ID.
 * @returns A slug suitable for a resource instance name.
 */
function chatInstanceName(chatID: string): string {
  const slug = chatID.replace(/[^A-Za-z0-9._-]+/g, "_").replace(
    /^_+|_+$/g,
    "",
  ).slice(0, 80);
  return `chat-${slug || "unknown"}`;
}

/**
 * Resolve the chat ID for a call, falling back to the default.
 *
 * @param explicit - Chat ID from method arguments, if any.
 * @param fallback - Chat ID from global arguments, if any.
 * @returns The resolved chat ID.
 */
function resolveChatID(
  explicit: string | undefined,
  fallback: string | undefined,
): string {
  const chatID = explicit ?? fallback;
  if (!chatID) {
    throw new Error(
      "No chat ID supplied. Pass chatID as a method argument or set globalArguments.defaultChatID.",
    );
  }
  return chatID;
}

/** Behavior definition for the Beeper Desktop integration. */
export const behavior = {
  type: "@gklijs/beeper",
  version: "2026.10.17.1",
  globalArguments: BeeperGlobalArgsSchema,
  resources: {
    "health": {
      description: "Account connectivity snapshot from the Beeper Desktop API",
      schema: HealthSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    "chats": {
      description: "Most recent chats across all Beeper accounts",
      schema: ChatsSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
    "messages": {
      description: "Recent messages read from one Beeper chat",
      schema: MessagesSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "message": {
      description: "A message sent through Beeper",
      schema: SentMessageSchema,
      lifetime: "90d",
      garbageCollection: 50,
    },
    "token": {
      description: "Access-token introspection result",
      schema: TokenSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  checks: {
    "beeper-configured": {
      description:
        "Verify the Beeper access token and default chat ID are configured",
      labels: ["policy"],
      execute: (context: {
        globalArgs: BeeperGlobalArgs;
      }): { pass: boolean; errors?: string[] } => {
        const errors: string[] = [];
        if (!context.globalArgs.accessToken.trim()) {
          errors.push("globalArguments.accessToken is empty");
        }
        if (
          context.globalArgs.defaultChatID !== undefined &&
          !context.globalArgs.defaultChatID.trim()
        ) {
          errors.push("globalArguments.defaultChatID is set but empty");
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
  },
  methods: {
    health: {
      description:
        "Check that the Beeper Desktop API is reachable and summarize account connectivity",
      kind: "read",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: BeeperGlobalArgs;
          logger: { info(msg: string, ...args: unknown[]): void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          signal?: AbortSignal;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        context.logger.info("Probing Beeper Desktop API at {baseUrl}", {
          baseUrl: context.globalArgs.baseUrl,
        });
        const startedAt = Date.now();
        const payload = await beeperRequest(
          context.globalArgs,
          "/v1/accounts",
          { method: "GET", retryOnThrottle: true },
          context.signal,
        );
        const latencyMs = Date.now() - startedAt;
        if (!Array.isArray(payload)) {
          throw new Error(
            "Beeper returned an unexpected body for /v1/accounts: expected an array.",
          );
        }
        const accounts = payload
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
          .map((account) => ({
            accountID: readString(account, "accountID") ?? "",
            network: readString(account, "network") ?? "unknown",
            status: readString(account, "status") ?? "unknown",
          }));
        const connectedCount =
          accounts.filter((account) => account.status === "connected").length;
        const degraded = connectedCount < accounts.length;
        const checkedAt = new Date().toISOString();
        const handle = await context.writeResource("health", "latest", {
          ok: true,
          baseUrl: context.globalArgs.baseUrl,
          latencyMs,
          accountCount: accounts.length,
          connectedCount,
          degraded,
          accounts,
          checkedAt,
        });
        context.logger.info(
          "Beeper reachable: {accountCount} account(s), {connectedCount} connected",
          { accountCount: accounts.length, connectedCount },
        );
        return { dataHandles: [handle] };
      },
    },
    listChats: {
      description: "List recent chats across all Beeper accounts, newest first",
      kind: "list",
      arguments: ListChatsArgsSchema,
      execute: async (
        args: z.infer<typeof ListChatsArgsSchema>,
        context: {
          globalArgs: BeeperGlobalArgs;
          logger: { info(msg: string, ...args: unknown[]): void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          signal?: AbortSignal;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        context.logger.info(
          "Listing Beeper chats (limit {limit}, cap {maxChats})",
          { limit: args.limit, maxChats: args.maxChats },
        );
        const chats: Array<{
          id: string;
          localChatID?: string;
          accountID: string;
          network: string;
          title?: string;
          type?: string;
          unreadCount: number;
          isMuted: boolean;
          isArchived: boolean;
          lastActivity?: string;
        }> = [];
        let cursor = args.cursor;
        let direction = args.direction;
        let truncated = false;
        let oldestCursor: string | undefined;
        let newestCursor: string | undefined;

        for (;;) {
          const query = new URLSearchParams();
          query.set("limit", String(args.limit));
          for (const accountID of args.accountIDs ?? []) {
            query.append("accountIDs", accountID);
          }
          if (cursor) {
            query.set("cursor", cursor);
            query.set("direction", direction ?? "before");
          }
          const envelope = asListEnvelope(
            await beeperRequest(
              context.globalArgs,
              `/v1/chats?${query.toString()}`,
              { method: "GET", retryOnThrottle: true },
              context.signal,
            ),
            "/v1/chats",
          );
          oldestCursor = envelope.oldestCursor ?? oldestCursor;
          newestCursor = envelope.newestCursor ?? newestCursor;
          for (const chat of envelope.items) {
            chats.push({
              id: readString(chat, "id") ?? "",
              localChatID: readString(chat, "localChatID"),
              accountID: readString(chat, "accountID") ?? "",
              network: readString(chat, "network") ?? "unknown",
              title: readString(chat, "title"),
              type: readString(chat, "type"),
              unreadCount: readInt(chat, "unreadCount") ?? 0,
              isMuted: readBoolean(chat, "isMuted"),
              isArchived: readBoolean(chat, "isArchived"),
              lastActivity: readString(chat, "lastActivity"),
            });
          }
          cursor = envelope.oldestCursor;
          direction = "before";
          if (!envelope.hasMore || !cursor || chats.length >= args.maxChats) {
            truncated = envelope.hasMore && chats.length >= args.maxChats;
            break;
          }
        }

        const written = chats.slice(0, args.maxChats);
        const handle = await context.writeResource("chats", "latest", {
          chats: written,
          count: written.length,
          truncated,
          oldestCursor,
          newestCursor,
          fetchedAt: new Date().toISOString(),
        });
        context.logger.info("Listed {count} Beeper chat(s)", {
          count: written.length,
        });
        return { dataHandles: [handle] };
      },
    },
    listMessages: {
      description: "Read recent messages from a Beeper chat",
      kind: "list",
      arguments: ListMessagesArgsSchema,
      execute: async (
        args: z.infer<typeof ListMessagesArgsSchema>,
        context: {
          globalArgs: BeeperGlobalArgs;
          logger: { info(msg: string, ...args: unknown[]): void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          signal?: AbortSignal;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const chatID = resolveChatID(
          args.chatID,
          context.globalArgs.defaultChatID,
        );
        context.logger.info(
          "Reading up to {maxMessages} message(s) from Beeper chat {chatID}",
          { maxMessages: args.maxMessages, chatID },
        );
        const messages: Array<{
          id: string;
          senderID: string;
          senderName?: string;
          timestamp: string;
          text?: string;
          type?: string;
          isSender: boolean;
          isDeleted: boolean;
          isHidden: boolean;
          linkedMessageID?: string;
        }> = [];
        let cursor = args.cursor;
        let direction = args.direction;
        let truncated = false;
        let oldestCursor: string | undefined;
        let newestCursor: string | undefined;

        for (;;) {
          const query = new URLSearchParams();
          if (cursor) {
            query.set("cursor", cursor);
            query.set("direction", direction ?? "before");
          }
          const suffix = query.size > 0 ? `?${query.toString()}` : "";
          const envelope = asListEnvelope(
            await beeperRequest(
              context.globalArgs,
              `/v1/chats/${encodeURIComponent(chatID)}/messages${suffix}`,
              { method: "GET", retryOnThrottle: true },
              context.signal,
            ),
            "/v1/chats/{chatID}/messages",
          );
          oldestCursor = envelope.oldestCursor ?? oldestCursor;
          newestCursor = envelope.newestCursor ?? newestCursor;
          for (const message of envelope.items) {
            const id = readString(message, "id");
            if (!id) {
              continue;
            }
            messages.push({
              id,
              senderID: readString(message, "senderID") ?? "",
              senderName: readString(message, "senderName"),
              timestamp: readString(message, "timestamp") ?? "",
              text: readString(message, "text"),
              type: readString(message, "type"),
              isSender: readBoolean(message, "isSender"),
              isDeleted: readBoolean(message, "isDeleted"),
              isHidden: readBoolean(message, "isHidden"),
              linkedMessageID: readString(message, "linkedMessageID"),
            });
          }
          cursor = envelope.oldestCursor;
          direction = "before";
          if (
            !envelope.hasMore || !cursor || messages.length >= args.maxMessages
          ) {
            truncated = envelope.hasMore && messages.length >= args.maxMessages;
            break;
          }
        }

        const written = messages.slice(0, args.maxMessages);
        const handle = await context.writeResource(
          "messages",
          chatInstanceName(chatID),
          {
            chatID,
            messages: written,
            count: written.length,
            truncated,
            oldestCursor,
            newestCursor,
            fetchedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Read {count} message(s) from {chatID}", {
          count: written.length,
          chatID,
        });
        return { dataHandles: [handle] };
      },
    },
    sendMessage: {
      description: "Send a text message to a Beeper chat",
      kind: "action",
      arguments: SendMessageArgsSchema,
      execute: async (
        args: z.infer<typeof SendMessageArgsSchema>,
        context: {
          globalArgs: BeeperGlobalArgs;
          logger: { info(msg: string, ...args: unknown[]): void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          signal?: AbortSignal;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const chatID = resolveChatID(
          args.chatID,
          context.globalArgs.defaultChatID,
        );
        const body: Record<string, unknown> = { text: args.text };
        if (args.replyToMessageID) {
          body.replyToMessageID = args.replyToMessageID;
        }
        context.logger.info("Sending a message to Beeper chat {chatID}", {
          chatID,
        });
        const payload = asRecord(
          await beeperRequest(
            context.globalArgs,
            `/v1/chats/${encodeURIComponent(chatID)}/messages`,
            { method: "POST", body: JSON.stringify(body) },
            context.signal,
          ),
        );
        const pendingMessageID = payload
          ? readString(payload, "pendingMessageID")
          : undefined;
        if (!pendingMessageID) {
          throw new Error(
            "Beeper did not return a pendingMessageID; the message may not have been accepted.",
          );
        }
        const sentAt = new Date().toISOString();
        const handle = await context.writeResource(
          "message",
          `msg-${pendingMessageID.replace(/[^A-Za-z0-9._-]+/g, "_")}`,
          {
            chatID: readString(payload ?? {}, "chatID") ?? chatID,
            pendingMessageID,
            text: args.text,
            replyToMessageID: args.replyToMessageID,
            sentAt,
          },
        );
        context.logger.info("Sent message {pendingMessageID} to {chatID}", {
          pendingMessageID,
          chatID,
        });
        return { dataHandles: [handle] };
      },
    },
    checkToken: {
      description:
        "Introspect the Beeper access token and report its status and expiry",
      kind: "read",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: BeeperGlobalArgs;
          logger: { info(msg: string, ...args: unknown[]): void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          signal?: AbortSignal;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        context.logger.info("Introspecting the Beeper access token");
        const form = new URLSearchParams({
          token: context.globalArgs.accessToken,
        });
        const payload = asRecord(
          await beeperRequest(
            context.globalArgs,
            "/oauth/introspect",
            {
              method: "POST",
              body: form.toString(),
              contentType: "application/x-www-form-urlencoded",
            },
            context.signal,
          ),
        );
        if (!payload) {
          throw new Error(
            "Beeper returned an empty body for /oauth/introspect.",
          );
        }
        const exp = readInt(payload, "exp");
        const iat = readInt(payload, "iat");
        const checkedAt = new Date().toISOString();
        const handle = await context.writeResource("token", "latest", {
          active: readBoolean(payload, "active"),
          tokenType: readString(payload, "token_type"),
          scope: readString(payload, "scope"),
          clientID: readString(payload, "client_id"),
          issuedAt: iat !== undefined
            ? new Date(iat * 1000).toISOString()
            : undefined,
          expiresAt: exp !== undefined
            ? new Date(exp * 1000).toISOString()
            : undefined,
          expiresInSeconds: exp !== undefined && iat !== undefined
            ? exp - iat
            : undefined,
          checkedAt,
        });
        context.logger.info("Token active: {active}", {
          active: readBoolean(payload, "active"),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
