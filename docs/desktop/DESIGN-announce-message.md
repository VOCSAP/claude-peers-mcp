# Deck announce / message -- design (2026-06-03)

Branch: `feat/desktop-announce-message`. Target: claude-peers MCP **v0.3.4** (broker + server.ts) plus a new outbound messaging layer in the desktop Deck.

## Goal

Let the Deck broadcast outbound, fire-and-forget system messages to the peers of a
group, surfaced inside each Claude Code session as a clearly-marked "do not reply"
announcement. Two triggers, one transport:

1. **Join announce (automatic):** when a session is spawned and its `peer_id`
   resolves, the Deck broadcasts "new peer joined: `<peer_id>` (agent/model/effort)"
   to the new peer's group.
2. **Free-text message (manual):** the operator types a message in a Deck message
   bar and clicks Send; the Deck broadcasts it to the **active session's group**.

The advanced create flow (CreateMenu) pre-fills the join announce text
(agent/model/effort) in an editable free-text field.

## Hard constraints

- **Outbound only (megaphone).** The Deck never reads inbound peer traffic in this
  phase. Replies and dialogue happen inside the Claude session terminals.
- **Peers must never reply to the Deck.** They may infer/react, but must not call
  `send_message` toward the Deck. Enforced server-side (see below), not by a plea in
  the message text.
- **Deck stays invisible in `list_peers`.** It is not a registered peer.

## Decisions (locked during brainstorming)

- **Identity = system sentinel sender.** A dedicated broker endpoint `POST /announce`
  inserts one message per active peer in the target group with
  `from_peer_id = "deck"` (reserved sentinel) and a non-routable `from_token`. No
  `kind` column, no schema migration: the sentinel `from_peer_id` both encodes
  "system" and is the server-side suppression key.
- **One channel, two uses.** Both the join announce and the free-text message go
  through `/announce`. The only difference is the text the Deck composes; the broker
  broadcasts verbatim.
- **Group scope = active session's group.** Free-text broadcasts target the group of
  the currently selected tile/session. Join announce targets the new peer's group.
- **`kind`/`label` columns rejected.** The join-vs-message distinction lives entirely
  in the composed text. No payload subtype needed.

## Architecture

```
Deck renderer ── IPC ──> Deck main (broker-client.ts) ── HTTP POST /announce ──> broker.ts
                                                                                    |
                                                       WS push / poll-messages      v
                          server.ts (MCP, per Claude session) <──────── message from="deck"
                                       |
                                       └─> <channel> rendered "Deck announcement -- do not reply"
```

### Components

- **`broker.ts`** (core, v0.3.4): new `POST /announce` endpoint. Validates the group
  (TOFU, same path as `/send-message`), selects active peers, inserts one
  `delivered=0` message each (`from_token='__deck__'`, `from_peer_id='deck'`), then
  pushes over WS to connected tokens via the existing push path. `set_id` rejects the
  reserved names `deck` and `system`.
- **`server.ts`** (core, v0.3.4): when a delivered message has `from_peer_id==="deck"`,
  render a distinct `<channel>` framing in **English** (max compatibility) that
  explicitly forbids replying, instead of the default "RESPOND IMMEDIATELY / reply
  with send_message" nudge.
- **`desktop/src/main/broker-client.ts`** (new, kept import-pure where possible):
  resolves group + broker URL from `shared/config.ts` (`resolveGroup`,
  `computeGroupId`, `computeGroupSecretHash`, `brokerUrl`) and POSTs `/announce`.
  Testable under `bun test`.
- **`desktop/src/main/ipc.ts`**: handlers `announce:send` (manual) and the
  join-announce trigger wiring (fired from the session spawn path once `peer_id`
  resolves).
- **Renderer**: a message bar (textarea + Send button, send icon on blue background)
  scoped to the active session's group; an editable pre-filled announce field in the
  advanced CreateMenu.

## Broker contract: `POST /announce`

Request body:

```json
{
  "group_id":  "<32-hex or 'default'>",
  "group_secret_hash": "<sha256 hex of group secret>",
  "text": "<verbatim message text>"
}
```

Auth: identical to existing routes -- Bearer `broker_token` in HTTP mode, loopback in
local mode.

Behaviour:
1. Resolve / TOFU-validate the group (reuse the `/send-message` group-resolution
   helper).
2. `SELECT instance_token FROM peers WHERE group_id=? AND status='active'`.
3. For each, insert a message: `from_token='__deck__'`, `from_peer_id='deck'`,
   `to_token=<peer>`, `group_id`, `text`, `delivered=0`, `sent_at=now`.
4. WS-push each connected target token (existing push path; never marks delivered --
   fire-and-forget contract from v0.3 preserved).
5. Respond `{ "sent": <N> }`.

Empty/active-less group -> `{ "sent": 0 }`. Group isolation: only peers of the given
`group_id` receive the message.

### Reserved sender guardrail

`set_id` (and `deriveDefaultId` collision logic) must never produce or accept the
reserved display ids `deck` / `system`. `handleSetId` returns 409/400 on attempt.
This keeps the suppression key unambiguous.

## server.ts reception rendering

On a delivered message with `from_peer_id === "deck"`, the `<channel>` block uses an
English no-reply framing, e.g.:

> Announcement from the operator (via the Deck). This is informational only. Do NOT
> reply, and do not call send_message toward "deck". You may take it into account in
> your work.

The normal peer-message framing (which instructs an immediate reply) is suppressed
for these messages.

## Deck UX

- **Join announce (auto):** after spawn, once `peer-state.resolvePeerId` yields the
  new session's `peer_id`, the Deck POSTs `/announce` to that session's group with
  `New peer: <peer_id> (agent X, model Y, effort Z)`. Fire-and-forget, never blocks
  the terminal (respects the existing "spawn must not block visibility" rule).
- **Advanced create (CreateMenu):** an editable text field pre-filled with the
  agent/model/effort summary. On create, this text becomes the join announce instead
  of the default.
- **Message bar:** a textarea + Send button (send icon, blue background). Sends the
  text to the active session's group via `announce:send`. Empty text disables Send.
- **Stretch (deferred, out of scope this phase):** per-peer checkboxes to target a
  subset of peers.

## Group + connectivity resolution

The Deck reuses `shared/config.ts` exactly as `server.ts` does:
- Local mode: `brokerUrl()` resolves the loopback broker the sessions already use.
- HTTP mode: `broker_url` + `broker_token` from config.
- Per session, the Deck already knows the resolved group context (it spawns each
  session with a group). The join announce uses that session's group; the free-text
  bar uses the active session's group. `computeGroupId` / `computeGroupSecretHash`
  produce the `/announce` auth fields.

## Testing

- `tests/broker-announce.test.ts`: `/announce` inserts N messages for N active peers
  (`from_peer_id='deck'`, `delivered=0`); empty group -> `sent:0`; group isolation
  (a peer in another group does not receive it); messages pollable via
  `/poll-messages`.
- `tests/broker-set-id.test.ts` (extend): `set_id("deck")` and `set_id("system")`
  rejected.
- server.ts no-reply rendering: extract the render decision into a pure helper if
  needed and unit-test that `from_peer_id="deck"` produces the no-reply framing.
- `desktop/tests/desktop-broker-client.test.ts`: `broker-client` composes the correct
  `/announce` payload and resolves group/url (injectable deps for testability, same
  discipline as existing pure desktop modules).
- Smoke: `bun build --target=bun broker.ts server.ts cli.ts --outdir=/tmp/cp-check`.
- Full: `bun test` (existing suite stays green; new suites added).

## Out of scope (this phase)

- Inbound message display / Deck inbox.
- Per-peer targeting (checkboxes).
- Any reply path back to the Deck.

## Version / docs

- Bump MCP to **v0.3.4**; update `CLAUDE.md` + `README.md` (new endpoint, new ENV if
  any, sentinel sender, reserved ids).
- Desktop version follows its own track; note the new messaging layer in desktop docs.
