# Phase 2 — Implementation Plan (collaboration layer)

> Read `DESIGN.md` (§12) first. This is a **frame plan**, not line-level detail:
> some specifics will be refined after Phase 1 ships. Reopen and tighten this
> file right before starting Phase 2.
> Goal: turn the dock into a lightweight team orchestrator — announce arrivals/
> departures, broadcast messages, onboard newcomers cheaply — **without the app
> ever being a visible/addressable peer**.

## 0. Prerequisites

- Phase 1 shipped (scope group, deterministic peer_id, i18n, agent args).
- The app already knows, per session: `uuid`, `peer_id`, launch `args`
  (⇒ the **role**, when launched via `--agent`), and the **group secret**
  (the scope) — everything `/announce` needs to authenticate and address.

## 1. Broker — `/announce` endpoint (Option B: send-only, invisible)

Chosen over a hidden-peer registration: the app **never registers**, is
**invisible by construction**, and **cannot receive**.

- [ ] New endpoint `POST /announce`:
  - Auth by **group secret** (so only someone holding the scope can post):
    body carries `group_secret_hash` (computed like peers do) or the raw secret
    hashed server-side; reject mismatch (same spirit as TOFU).
  - Payload: `{ group_secret_hash, kind: "info" | "broadcast", text, targets?: peer_id[] }`.
  - **Fan-out** to peers in that `group_id`: if `targets` omitted → all active
    peers; else the listed ones. Reuse existing message storage + WS push +
    poll delivery.
  - `from` is a **non-peer sentinel** (e.g. `from_token = null` / a reserved
    "controller" marker) — there is **no peer row** for the app.
  - Respect HTTP-mode bearer auth like other endpoints.
- [ ] Message persistence: store with a flag marking it app-originated +
  `kind`, so `server.ts` can render it correctly and so it is **never routed
  back** to a non-existent sender.
- [ ] Tests: `tests/broker-announce.test.ts` — secret auth (accept/reject),
  fan-out to all vs targets, delivery via WS + poll, no peer row created, app
  not visible in `list_peers`.

## 2. Protocol / `server.ts` — no-reply rendering

- [ ] Recognize app-originated messages (`kind`/flag) and render them with
  **explicit framing**: e.g.
  `<channel source="claude-peers" kind="announcement" reply="no" from="deck">…</channel>`
  with a one-line instruction: *"Context only — do NOT reply to the sender (it is
  not a peer). You may act in your own session or message other peers."*
- [ ] This **neutralizes** the global "RESPOND IMMEDIATELY" rule **for this kind
  only**. Regular peer→peer messages are unchanged.
- [ ] Shared invariant (both `info` and `broadcast`): the app is **never a
  `to_peer_id`**. Difference is intent/wording only:
  - `info` — auto join/leave, "for your awareness";
  - `broadcast` — user message ("say hi to the newcomer"), peers may infer and
    act among themselves.
- [ ] Tests: a peer receiving an `info`/`broadcast` does not attempt to message
  the app; delivery + rendering shape asserted.

## 3. App — announce on add / remove

- [ ] On **session add**: popup **free-text field** (i18n) to enrich the message.
  Final text = i18n base template (`announce.joined = "{peer} ({role}) joined the group."`)
  + appended custom text. Resolve `role` from launch args (`--agent`).
  → `POST /announce { kind: "info", text }`.
- [ ] On **session remove**: `info` announce `announce.left = "{peer} left the group."`
  (no popup, or optional).
- [ ] Texts come from `locales/*.json` (`announce.*` keys). **App renders the
  final localized string**; broker stays i18n-agnostic.

## 4. App — bottom broadcast field

- [ ] Persistent input + **Send** at the bottom of the window → `POST /announce
  { kind: "broadcast", text, targets? }` to all peers (or a selection).
- [ ] **Target selection UI** (deferred detail): multi-select in the sidebar
  (checkboxes/chips). Default = all.
- [ ] Covers on-demand prompts, e.g. "describe in 20 words what you're working
  on" (the summary-refresh lever).

## 5. Onboarding (token-cheap, via existing summaries)

- [ ] **Newcomer learns the team** by calling `list_peers` **once** (returns each
  peer's `summary`) — zero interruption to others. Seed via an **initial prompt
  at launch**: `<launchCommand> --agent <role> --session-id <uuid> "<onboarding prompt>"`
  (DESIGN §14.2: verify it starts interactive). If not viable, the app pushes a
  message to the newcomer after creation.
  - Onboarding prompt (i18n, `onboarding.seed`): *"You joined team scope
    {scope}. Run list_peers to see your teammates and their summaries, set your
    own summary, then introduce yourself."*
- [ ] **Staleness handling**: summaries are set once at register (+1 LLM upgrade)
  and only refreshed when a peer re-calls `set_summary` — no auto-refresh
  (verified). Accept cheap passive baseline; use the **broadcast field** (§4) for
  **on-demand** refresh when it matters (e.g. right after a newcomer arrives).

## 6. Agent / team UX polish (carried from Phase 1 "out")

- [ ] Agent **dropdown** populated from `.claude/agents` (project) +
  `~/.claude/agents` (global), frontmatter `name`.
- [ ] Team presets surfaced in the create menu (reviewer / developer /
  team-lead) with their args + optional onboarding prompt.

## 7. Validation (definition of done, Phase 2)

- [ ] Broker tests green (announce auth, fan-out, no peer row, invisibility).
- [ ] `server.ts` renders no-reply messages; peers don't reply to the app.
- [ ] Manual: add a session → existing peers receive the join notice and do not
  try to message the app; newcomer onboards via `list_peers` summaries; bottom
  broadcast reaches all/selected peers; a broadcast "describe in 20 words"
  refreshes summaries.
- [ ] i18n: announce/onboarding texts localized via `locales/*.json`.

## 8. Risks / to revisit before starting

- Exact `/announce` auth shape (raw secret vs precomputed hash) vs existing
  TOFU/bearer mechanics — align with `broker.ts` conventions at implementation
  time.
- Whether to keep `from = null` or introduce a reserved controller token (DB FK
  constraints on `messages.from_token` — check `broker.ts` schema; may need the
  flag/route to bypass the FK).
- Selection UI ergonomics (defer until the broadcast feature is used).
