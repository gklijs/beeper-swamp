/**
 * Unit tests for the Beeper Desktop behavior.
 *
 * All HTTP calls are intercepted with `withMockedFetch`, so no real Beeper
 * Desktop instance or network access is required.
 *
 * @module
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20261014.55";
import { behavior } from "./beeper.ts";

/** Context type accepted by one of the behavior's methods. */
type ExecuteContext<M extends keyof typeof behavior.methods> = Parameters<
  (typeof behavior.methods)[M]["execute"]
>[1];

Deno.test("health summarizes account connectivity", async () => {
  const { result: resource, calls } = await withMockedFetch(
    (req) => {
      assertEquals(new URL(req.url).pathname, "/v1/accounts");
      assertEquals(req.headers.get("authorization"), "Bearer test-token");
      return Response.json([
        { accountID: "matrix", network: "Beeper", status: "connected" },
        {
          accountID: "local-whatsapp_x",
          network: "WhatsApp",
          status: "connecting",
        },
      ]);
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          baseUrl: "http://127.0.0.1:23373",
          accessToken: "test-token",
        },
      });
      await behavior.methods.health.execute(
        {},
        context as unknown as ExecuteContext<"health">,
      );
      return getWrittenResources()[0];
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(resource.specName, "health");
  const data = resource.data as Record<string, unknown>;
  assertEquals(data.ok, true);
  assertEquals(data.accountCount, 2);
  assertEquals(data.connectedCount, 1);
  assertEquals(data.degraded, true);
});

Deno.test("health throws a clear error on 401", async () => {
  const { context } = createModelTestContext({
    globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "bad" },
  });
  await assertRejects(
    () =>
      withMockedFetch(
        () => new Response("nope", { status: 401 }),
        () =>
          behavior.methods.health.execute(
            {},
            context as unknown as ExecuteContext<"health">,
          ),
      ),
    Error,
    "HTTP 401",
  );
});

Deno.test("health rejects a non-JSON body", async () => {
  const { context } = createModelTestContext({
    globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
  });
  await assertRejects(
    () =>
      withMockedFetch(
        () => new Response("not json", { status: 200 }),
        () =>
          behavior.methods.health.execute(
            {},
            context as unknown as ExecuteContext<"health">,
          ),
      ),
    Error,
    "non-JSON",
  );
});

Deno.test("listChats maps chats and reports truncation", async () => {
  const { result: resource } = await withMockedFetch(
    () =>
      Response.json({
        hasMore: true,
        items: [
          {
            id: "!chat_1:beeper.com",
            accountID: "matrix",
            network: "Beeper",
            title: "Alice",
            type: "single",
            unreadCount: 3,
            isMuted: false,
            isArchived: false,
            lastActivity: "2026-05-05T20:20:12.497Z",
          },
        ],
        newestCursor: "n1",
        oldestCursor: "o1",
      }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
      });
      await behavior.methods.listChats.execute(
        { limit: 100, maxChats: 1 },
        context as unknown as ExecuteContext<"listChats">,
      );
      return getWrittenResources()[0];
    },
  );
  assertEquals(resource.specName, "chats");
  const data = resource.data as Record<string, unknown>;
  assertEquals(data.count, 1);
  assertEquals(data.truncated, true);
  const chats = data.chats as Array<Record<string, unknown>>;
  assertEquals(chats[0].title, "Alice");
  assertEquals(chats[0].unreadCount, 3);
});

Deno.test("listMessages uses defaultChatID and writes a chat-scoped name", async () => {
  const { result: resource } = await withMockedFetch(
    (req) => {
      assertEquals(
        new URL(req.url).pathname,
        "/v1/chats/!room_x%3Abeeper.com/messages",
      );
      return Response.json({
        hasMore: false,
        items: [
          {
            id: "m1",
            senderID: "@alice:beeper.com",
            senderName: "Alice",
            timestamp: "2026-05-05T20:20:12.497Z",
            text: "hello",
            type: "TEXT",
            isSender: false,
            isDeleted: false,
          },
        ],
        newestCursor: "n",
        oldestCursor: "o",
      });
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          baseUrl: "http://127.0.0.1:23373",
          accessToken: "t",
          defaultChatID: "!room_x:beeper.com",
        },
      });
      await behavior.methods.listMessages.execute(
        { maxMessages: 50 },
        context as unknown as ExecuteContext<"listMessages">,
      );
      return getWrittenResources()[0];
    },
  );
  assertEquals(resource.specName, "messages");
  assertEquals(resource.name, "chat-room_x_beeper.com");
  const data = resource.data as Record<string, unknown>;
  assertEquals(data.chatID, "!room_x:beeper.com");
  assertEquals(data.count, 1);
  const messages = data.messages as Array<Record<string, unknown>>;
  assertEquals(messages[0].text, "hello");
  assertEquals(messages[0].isHidden, false);
});

Deno.test("listMessages requires a chat ID", async () => {
  const { context } = createModelTestContext({
    globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
  });
  await assertRejects(
    () =>
      behavior.methods.listMessages.execute(
        { maxMessages: 50 },
        context as unknown as ExecuteContext<"listMessages">,
      ),
    Error,
    "No chat ID supplied",
  );
});

Deno.test("sendMessage posts text and records the pending message", async () => {
  const { result: resource, calls } = await withMockedFetch(
    (req) => {
      assertEquals(req.method, "POST");
      return Response.json({
        chatID: "!room:beeper.com",
        pendingMessageID: "pending-1",
      });
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
      });
      await behavior.methods.sendMessage.execute(
        { chatID: "!room:beeper.com", text: "hi" },
        context as unknown as ExecuteContext<"sendMessage">,
      );
      return getWrittenResources()[0];
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].body, JSON.stringify({ text: "hi" }));
  assertEquals(resource.specName, "message");
  assertEquals(resource.name, "msg-pending-1");
  const data = resource.data as Record<string, unknown>;
  assertEquals(data.pendingMessageID, "pending-1");
  assertEquals(data.text, "hi");
});

Deno.test("checkToken derives expiry from introspect", async () => {
  const { result: resource, calls } = await withMockedFetch(
    (req) => {
      assertEquals(new URL(req.url).pathname, "/oauth/introspect");
      assertEquals(
        req.headers.get("content-type"),
        "application/x-www-form-urlencoded",
      );
      return Response.json({
        active: true,
        token_type: "Bearer",
        scope: "read",
        client_id: "beeper-desktop",
        iat: 1_700_000_000,
        exp: 1_700_003_600,
      });
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: {
          baseUrl: "http://127.0.0.1:23373",
          accessToken: "test-token",
        },
      });
      await behavior.methods.checkToken.execute(
        {},
        context as unknown as ExecuteContext<"checkToken">,
      );
      return getWrittenResources()[0];
    },
  );
  assertEquals(calls[0].body, "token=test-token");
  assertEquals(resource.specName, "token");
  const data = resource.data as Record<string, unknown>;
  assertEquals(data.active, true);
  assertEquals(data.expiresInSeconds, 3600);
  assertEquals(data.expiresAt, new Date(1_700_003_600 * 1000).toISOString());
});

Deno.test("searchMessages queries /v1/messages/search", async () => {
  const { result: resource, calls } = await withMockedFetch(
    (req) => {
      const url = new URL(req.url);
      assertEquals(url.pathname, "/v1/messages/search");
      assertEquals(url.searchParams.get("query"), "dinner");
      return Response.json({
        hasMore: false,
        items: [
          {
            id: "m9",
            chatID: "!room:beeper.com",
            senderID: "@bob:beeper.com",
            timestamp: "2026-05-05T20:20:12.497Z",
            text: "dinner at 7?",
            isSender: false,
            isDeleted: false,
            isHidden: false,
          },
        ],
        newestCursor: "n",
        oldestCursor: "o",
      });
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
      });
      await behavior.methods.searchMessages.execute(
        { query: "dinner", maxMessages: 50 },
        context as unknown as ExecuteContext<"searchMessages">,
      );
      return getWrittenResources()[0];
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(resource.specName, "search");
  const data = resource.data as Record<string, unknown>;
  assertEquals(data.query, "dinner");
  assertEquals(data.count, 1);
});

Deno.test("broadcast sends to every chat and reports failures", async () => {
  const { result: resource, calls } = await withMockedFetch(
    (req) => {
      if (new URL(req.url).pathname.endsWith("chat-b/messages")) {
        return Response.json({ chatID: "chat-b", pendingMessageID: "p-b" });
      }
      return new Response("boom", { status: 500 });
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
      });
      await behavior.methods.broadcast.execute(
        { chatIDs: ["chat-a", "chat-b"], text: "alert", queueOnFailure: false },
        context as unknown as ExecuteContext<"broadcast">,
      );
      return getWrittenResources()[0];
    },
  );
  assertEquals(calls.length, 2);
  assertEquals(resource.specName, "broadcast");
  const data = resource.data as Record<string, unknown>;
  assertEquals(data.sentCount, 1);
  assertEquals(data.failedCount, 1);
});

Deno.test("broadcast queues transient failures to the outbox", async () => {
  const { result: resources, calls } = await withMockedFetch(
    () => new Response("slow down", { status: 429 }),
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
      });
      await behavior.methods.broadcast.execute(
        { chatIDs: ["chat-a"], text: "alert", queueOnFailure: true },
        context as unknown as ExecuteContext<"broadcast">,
      );
      return getWrittenResources();
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(resources.length, 2);
  assertEquals(resources[0].specName, "broadcast");
  assertEquals(resources[1].specName, "outbox");
  const outbox = resources[1].data as Record<string, unknown>;
  const pending = outbox.pending as Array<Record<string, unknown>>;
  assertEquals(pending.length, 1);
  assertEquals(pending[0].chatID, "chat-a");
});

Deno.test("queueMessage writes an outbox entry", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {
      baseUrl: "http://127.0.0.1:23373",
      accessToken: "t",
      defaultChatID: "!room:beeper.com",
    },
  });
  await behavior.methods.queueMessage.execute(
    { text: "later" },
    context as unknown as ExecuteContext<"queueMessage">,
  );
  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "outbox");
  const data = resources[0].data as Record<string, unknown>;
  const pending = data.pending as Array<Record<string, unknown>>;
  assertEquals(pending.length, 1);
  assertEquals(pending[0].text, "later");
});

Deno.test("flushQueue delivers pending and keeps failures", async () => {
  const { result: resource, calls } = await withMockedFetch(
    (req) => {
      if (new URL(req.url).pathname.includes("good")) {
        return Response.json({ chatID: "good", pendingMessageID: "p-1" });
      }
      return new Response("down", { status: 503 });
    },
    async () => {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
      });
      await behavior.methods.flushQueue.execute(
        {
          maxFlush: 25,
          pending: [
            {
              chatID: "good",
              text: "hi",
              queuedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              chatID: "bad",
              text: "yo",
              queuedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        context as unknown as ExecuteContext<"flushQueue">,
      );
      return getWrittenResources()[0];
    },
  );
  assertEquals(calls.length, 2);
  assertEquals(resource.specName, "outbox");
  const data = resource.data as Record<string, unknown>;
  const flushed = data.flushed as Array<unknown>;
  const pending = data.pending as Array<unknown>;
  assertEquals(flushed.length, 1);
  assertEquals(pending.length, 1);
});

Deno.test("listChats retries once when the API is throttled", async () => {
  const { result: resource, calls } = await withMockedFetch([
    new Response("slow down", {
      status: 429,
      headers: { "Retry-After": "0" },
    }),
    Response.json({
      hasMore: false,
      items: [],
      newestCursor: "n",
      oldestCursor: "o",
    }),
  ], async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { baseUrl: "http://127.0.0.1:23373", accessToken: "t" },
    });
    await behavior.methods.listChats.execute(
      { limit: 100, maxChats: 500 },
      context as unknown as ExecuteContext<"listChats">,
    );
    return getWrittenResources()[0];
  });
  assertEquals(calls.length, 2);
  assertEquals((resource.data as Record<string, unknown>).count, 0);
});
