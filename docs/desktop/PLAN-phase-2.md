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

> ⛔ **BLOCKING decision — day 1 of Phase 2** (deferred by agreement; revisit
> then): how an app-originated announcement is stored/delivered, since
> `messages.from_token` has a **FK** to `peers(instance_token)`. Three options,
> to be chosen at Phase 2 start (**not now**):
> 1. **Separate announcements table** + dedicated WS frame — no FK, cleanest
>    semantics (announcements aren't peer→peer messages). *(Claude's lean.)*
> 2. **Reserved "controller" peer row** per group — keeps the FK, but a fake peer
>    to exclude from `list_peers`.
> 3. **Allow `from_token = NULL`** via migration — most invasive semantically.

- [ ] New endpoint `POST /announce`:
  - Auth by **group secret** (only a scope holder can post): body carries
    `group_secret_hash`; reject mismatch (TOFU spirit). Respect HTTP bearer auth.
  - Payload: `{ group_secret_hash, kind: "info" | "broadcast", text, targets?: peer_id[] }`.
  - **Fan-out** to peers in that `group_id` (all active, or `targets`), via the
    delivery model chosen above.
  - The app has **no peer row** and is **never a reply target**.
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

- [ ] On **session add**: announce **automatically and silently** with the base
  template (no forced popup — it would interrupt rapid creation). Enrichment is
  **opt-in**: an "add a note" field in the advanced CreateMenu, and/or
  **retroactive editing** from the sidebar. Global setting "announce on create:
  on/off".
  - Final text = i18n base template
    (`announce.joined = "{peer} ({role}) joined the group."`) + optional note.
    `role` resolved from launch args (`--agent`).
  - → `POST /announce { kind: "info", text }`.
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

- **Delivery/FK model = the ⛔ blocking decision in §1** (separate table vs
  controller token vs NULL). Decide before any `/announce` code.
- Exact `/announce` auth shape (raw secret vs precomputed hash) — align with
  `broker.ts` TOFU/bearer conventions at implementation time.
- **Thinking indicator (real solution):** replace the Phase 1 PTY placeholder
  with `UserPromptSubmit` + `Stop` hooks writing a per-session state file. Open:
  the **injection mechanism** (verify `--settings <file>`, or a gitignored
  `.claude/settings.local.json`) so we never touch the user's config.
- **Cross-host workspace lock:** delegate to the broker (single authoritative
  clock) instead of comparing two machines' heartbeats (DESIGN §6.5/§15).
- Selection UI ergonomics (defer until the broadcast feature is used).
