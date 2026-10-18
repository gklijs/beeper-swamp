# @gklijs/beeper

Integrate the [Beeper Desktop](https://www.beeper.com/) local API with swamp.
Beeper Desktop is a unified chat client that bridges WhatsApp, Signal, Telegram,
Discord, Slack, Instagram, Messenger, iMessage, and more. Its local HTTP API
(default `http://127.0.0.1:23373`) exposes those networks over a single token,
so swamp can read and send messages across networks that have no public API of
their own.

Use this extension to deliver workflow alerts into any chat you already read, or
to pull cross-network message history into a swamp repository.

## Installation

```sh
swamp extension install @gklijs/beeper
```

## Configure

Create a behavior instance with an access token from Beeper Desktop (**Settings
-> Developers -> Access token**). The token is marked sensitive, so store the
value in a vault and reference it:

```sh
swamp vault put default BEEPER_ACCESS_TOKEN
```

```yaml
# models/@gklijs/beeper.yaml
type: "@gklijs/beeper"
name: beeper
globalArguments:
  baseUrl: http://127.0.0.1:23373
  accessToken: ${{ vault.get(default, BEEPER_ACCESS_TOKEN) }}
  defaultChatID: "!room:example.local"
```

Then verify connectivity:

```sh
swamp behavior run beeper health
```

## Usage

Send an alert from a workflow step. `chatID` falls back to
`globalArguments.defaultChatID` when omitted:

```yaml
# workflows/alert.yaml
steps:
  - name: notify
    type: model_method
    model: beeper
    method: sendMessage
    arguments:
      text: "Integration health check failed"
```

Read the latest messages from a chat, or discover chat IDs with `listChats`:

```sh
swamp behavior run beeper listChats
swamp behavior run beeper listMessages --chatID '!room:example.local'
swamp behavior run beeper checkToken
```

## Methods

- `health` — ping `/v1/accounts`, report reachability, latency, and per-account
  connection status.
- `listChats` — page through recent chats across all accounts.
- `listMessages` — read recent messages from one chat (falls back to
  `defaultChatID`).
- `sendMessage` — send a text message, optionally as a reply.
- `searchMessages` — search messages across chats via `/v1/messages/search`
  (literal word match, filters for chats, accounts, sender, date range).
- `broadcast` — send the same text to up to 50 chats; transient failures are
  queued to the `outbox` resource when `queueOnFailure` is set.
- `queueMessage` — stage a message in the `outbox` for later delivery.
- `flushQueue` — deliver queued `outbox` entries (pass `pending` from the
  outbox resource); failures stay queued with `lastError`.
- `checkToken` — introspect the access token and report its expiry.

```sh
swamp behavior run beeper searchMessages --query 'dinner'
swamp behavior run beeper broadcast --chatIDs '["!a:x","!b:x"]' --text 'deploy done'
```

## Workflows

`workflows/workflow-poll-alerts.yaml` (`@gklijs/beeper-poll-alerts`) polls a
chat, searches for a keyword, forwards a summary, and flushes queued retries —
runnable documentation for wiring the behavior into a pipeline:

## How it works

The extension issues authenticated `Bearer` requests to the Beeper Desktop API
and stores results as swamp resources (all timestamps are ISO-8601). `listChats`
and `listMessages` follow the API's cursor pagination up to a configurable cap
and set a `truncated` flag when the cap is reached; throttled requests (`429`)
are retried honoring `Retry-After`.

Requirements and caveats:

- Beeper Desktop must be running on the same host as the token, and the API is
  bound to loopback only. Under WSL2 the Windows loopback is not reachable from
  Linux; either enable
  [mirrored networking](https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking)
  or point `baseUrl` at a Windows port proxy.
- Beeper's API is intended for personal automation. Do not use it for bulk or
  unsolicited messaging.
- The API is local-only; there is no cloud endpoint.

## License

MIT — see LICENSE for details.
