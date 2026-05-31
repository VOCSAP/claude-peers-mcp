# Claude Peers Desk — Design & Decisions

> **Status:** design frozen for Phase 1, Phase 2 outlined.
> **Purpose:** durable record of every decision taken so far. This file is the
> source of truth and survives any context loss. If a session is compacted or
> restarted, re-read this file + the two PLAN files to restore full context.

## 1. What we are building

A **desktop app that docks multiple Claude Code "peer" sessions into a single
window**, instead of juggling many floating terminals. Launched from a CLI
binary inside a project directory, it:

- shows a **left menu** to create / delete / select sessions,
- tiles every **live session** in the remaining space (the right area),
- lets one session go **fullscreen** (maximize/reduce),
- scopes all its sessions to a **per-launch peer group** so they only discover
  each other (no leak to unrelated peers),
- can **persist & restore** the whole workspace, resuming each Claude session
  with its original context and launch arguments.

It evolves (Phase 2) into a lightweight **team orchestrator**: create sessions
as agents (reviewer / developer / team-lead), announce arrivals/departures to
the group, and broadcast messages — without the app ever being a visible peer.

## 2. Tech stack (decided)

**Electron + electron-vite + React + TypeScript + `@xterm/xterm` + `node-pty`.**

Rationale (verified, May 2026):
- A real **PTY** is mandatory: Claude Code's browser OAuth and full TUI only
  work in a true pseudo-terminal, not a captured stdout.
- `node-pty` + `@xterm/xterm` are the **VS Code terminal stack**, co-maintained
  by the same team — the most battle-tested cross-platform PTY combo, **ConPTY
  included** on Windows.
- **Tauri rejected**: its PTY chain (`tauri-plugin-pty` 0.1.x single-maintainer
  → `portable-pty`) has **known ConPTY gaps** on Windows (a fork
  `portable-pty-psmux` exists, Apr 2026, just to fix them). This reproduces the
  exact "unmaintained native lib" risk we wanted to avoid.
- **Go + Wails**: viable second choice (PTY via `go-pty`/Charmbracelet ConPTY is
  fine) but Wails v3 is alpha and we'd write more PTY↔frontend plumbing
  ourselves. Not chosen.

Sources: node-pty (Microsoft, healthy), @xterm/xterm v6 (monthly releases),
portable-pty (ConPTY gaps), go-pty (Charmbracelet), Wails v3 (alpha).

## 3. Launch model (decided)

- Distributed as a **CLI binary on PATH**, like `claude`:
  - `package.json` `bin`: `"claude-peers-desk": "./bin/launch.js"`.
  - User installs **once** with `npm link` (or `npm i -g .`) from `desktop/`.
  - **Not `npx`**: the app is not standalone — it needs the cloned repo + the
    claude-peers MCP server installed. `npx` would not fit.
- Run **inside a project directory**: `cwd` = the project the window is scoped to.
- Optional positional argument = **custom scope id**:
  - `claude-peers-desk` → unique, app-only scope (this launch only).
  - `claude-peers-desk mon-id-de-scope` → shared scope across any app passing
    the same id.

## 4. Peer scope / group model (decided)

Goal: sessions opened by the app **only discover each other**, never leak to
unrelated peers; and two app launches are isolated unless explicitly shared.

- **Default (no arg):** generate a **random secret (UUID) per launch**.
  `group_id = sha256(secret)` ⇒ guaranteed unique per launch, even two apps in
  the same `cwd`. This **sidesteps any cwd-collision problem**.
- **Custom arg:** the scope **secret = the arg string** ⇒ apps sharing the same
  string share the group.
- **Display name** (human-readable, for the UI and `whoami`/`list_groups`):
  the **peer-root** derived exactly like `deriveDefaultId`'s base, minus the
  incremental suffix:
  ```
  sanitize(s) = s.toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"")
  hostPart = sanitize(host).slice(0,20) || "peer"
  cwdPart  = sanitize(basename(cwd)).slice(0,12)
  root     = cwdPart ? `${hostPart}-${cwdPart}` : hostPart   // e.g. "olivier-pc-claude-peers"
  ```
  Isolation rests on the **secret**, not the name — so a readable, possibly
  colliding name is fine.
- **Injection:** a **new dominant env var** in the claude-peers core, injected
  per child process via node-pty's `env` option. This is **non-invasive**: it
  affects only the spawned terminal, never the user's shell, global env, or any
  project file. (Verified correct approach.)
- **Core change required** (claude-peers): the current `CLAUDE_PEERS_GROUP` env
  var is **near-last** in `resolveGroupName` precedence (after `.claude-peers*.json`
  and `default_group`) and group **isolation requires a secret** that cannot be
  passed by env today. So we add a **top-precedence forced-group env path**
  (see Phase 1 plan, §"Core change"). Proposed names:
  - `CLAUDE_PEERS_FORCE_GROUP` — the scope secret (top precedence; overrides
    files, `default_group`, and `CLAUDE_PEERS_GROUP`).
  - `CLAUDE_PEERS_FORCE_GROUP_NAME` — optional display label (the root above).
- **All app sessions join the same group**, computed **once from the app launch
  dir**, even sessions opened in another folder.
- **Host is included** in the display root ⇒ the same project on two machines =
  two groups. Accepted: the app docks *local* sessions.
- **Limitation (by design):** the group is **fixed at launch** — no live change.
  To change scope, close and relaunch with the desired value.

## 5. Session identity & peer_id display (decided, verified)

- The app **mints a UUID** and launches each session with `--session-id <uuid>`
  (verified flag) ⇒ the app knows the session id up front.
- It also sets `CLAUDE_PEERS_STATUS_LINE_CACHE=1` ⇒ the claude-peers `server.ts`
  writes `~/.claude/peers/peer-id-<cwdKey>-<CLAUDE_CODE_SESSION_ID>.txt` on each
  register (`server.ts:770`, `:887`).
- Because `CLAUDE_CODE_SESSION_ID == <uuid>`, the cache file is
  **deterministic**: `peer-id-<cwdKey>-<uuid>.txt`. The app reads that exact
  file ⇒ **unambiguous peer_id even when many sessions share the project cwd**.
- The broker `/list-peers` is **not usable** by the app: `handleListPeers`
  (`broker.ts:579`) requires the caller's `instance_token` (a registered peer).
  The app is not a peer ⇒ excluded.
- **To verify empirically on the target machine:** that `--session-id <uuid>`
  propagates as `CLAUDE_CODE_SESSION_ID == uuid` to the MCP server. Fallback if
  not: scan `peer-id-<cwdKey>-*.txt` by mtime (only safe for 1 session/cwd —
  hence why the deterministic path matters).
- **Placeholder before peer_id resolves (~1-2 s):** show `Session <uuid[:8]>`,
  then switch to the peer_id once the file appears.

## 6. Persist / restore (decided, verified)

- Persist per session: `{ uuid, cwd, name, args }` + the workspace layout + app
  config.
- **Restore** = relaunch `<launchCommand> --resume <uuid> [original args]`
  (verified `--resume`/`-r` works in interactive TUI). This **continues the same
  session** (same id, same history) and **re-applies original invocation
  constraints** (e.g. `--agent`).
- `--fork-session` exists if we ever want to clone instead of continue (not the
  default).

## 7. Launch-command config (decided)

Three distinct config systems — do **not** conflate:
1. **claude-peers core** config (`~/.config/claude-peers/` or `%APPDATA%\claude-peers\`) — broker/groups/summary.
2. **App UI/state** config (Electron `userData`) — window/layout/session state.
3. **Launch-command** config (new) — how to invoke Claude.

**Launch-command resolution (first wins):**
1. `<project>/.claude/claude-peers/config.json` (local, created on demand)
2. **global app config** in `%APPDATA%\claude-peers-desk\config.json` (Windows)
   / `$XDG_CONFIG_HOME/claude-peers-desk/config.json` (Linux/macOS) — managed
   via the app UI
3. hardcoded default: `claude --dangerously-load-development-channels server:claude-peers`

Fields (minimum): `launchCommand` (string) + free args added via the "+ ▾"
advanced-create menu. **Agent presets**: a named list `{ label, args, prompt? }`
the "+ ▾" menu proposes alongside free input.

## 8. Agents (decided, polish later)

- Claude Code persistent agents live in `.claude/agents/*.md` (project) and
  `~/.claude/agents/*.md` (global), with frontmatter (`name`, `description`,
  `model`, `tools`). Started via `--agent <name>` (verified).
- Advanced create UI: an **"Agent" dropdown** populated by scanning those dirs
  (project first, then global). This is **UI polish** layered on top of the
  Phase 1 core requirement, which is simply: **support arbitrary args**
  (including `--agent xxx`).

## 9. UI / layout (decided)

```
┌───────────────┬─────────────────────────────────────┐
│  MENU (left)  │   TILES AREA (right, all remaining)  │
│ ──────────────│  sessions auto-share the space       │
│ + ▾  (create) │  display modes: 1×1 / 1×2 / 2×2 / X×Y │
│ ──────────────│  ┌──────────┐ ┌──────────┐           │
│ ⚡ peerA [⤢]✕ │  │ peer A   │ │ peer B    │ (selected │
│ ⚡ peerB [⤢]✕ │  │          │ │ highlight)│  outlined)│
│ ⚡ peerC [⤢]✕ │  └──────────┘ └──────────┘            │
│               │                                       │
│ [free-text ………………… broadcast input ……… ] [Send] (P2)│
└───────────────┴─────────────────────────────────────┘
```

- **Left menu:** session list; create (`+` with `▾` for advanced), delete
  **with confirmation**. Each row = `[thinking icon][peer_id]`.
- **Single click** = select/highlight the session in the tiles area.
- **Double click** = fullscreen in the tiles area (toggle, single slot):
  - same session double-clicked again ⇒ reduce;
  - another session ⇒ previous reduces, new expands.
  - Each tile also has a maximize/reduce button.
- **Display-mode selector** for the tiles area:
  - **1×1 "carousel"**: one full-size session, navigate horizontally between
    conversations (scrollbar + mouse wheel);
  - **1×2**, **2×2**;
  - **Custom X×Y**: free input of columns × rows; the grid shows X·Y cells and
    overflow is scrollable.
  - Maximize/fullscreen overrides the current mode.
- **Thinking indicator** (first position on each row): see §10.

## 10. "Thinking" indicator (decided)

- No public API/env exposes Claude's busy/idle state (verified).
- **Approach B first** (chosen): heuristic on the PTY output stream the app
  already renders (spinner glyphs / "esc to interrupt" markers). Zero config for
  the user, but brittle across Claude Code versions.
- Fallback / later: lean on the existing peer activity status.

## 11. i18n (decided)

- All user-facing texts in **external locale files** (`locales/en.json`,
  `locales/fr.json`), **not bundled** into the build: loaded at runtime from the
  app dir **and** overridable from a user dir (edit/add a language without
  recompiling). An English base may be embedded as a last-resort fallback.
- **Commit `en` + `fr`** in the repo for community sharing.
- `t(key, params)` helper with placeholders (`{peer}`, `{role}`, `{custom}`…).
- **Announce templates live in these locale files.** The **app renders the final
  localized string**; `/announce` transports an already-built string ⇒ the
  broker stays i18n-agnostic.
- Locale selection: app config + OS default.

## 12. Phase 2 — collaboration (outlined)

- **`/announce` endpoint** (Option B, chosen over a hidden-peer registration):
  **send-only**, authenticated by the **group secret**, fans out to all peers in
  the group. The app **never registers** and is **invisible by construction**;
  it cannot receive.
- **Reply semantics (refined, common to all app-originated messages):** the app
  is **never a reply target** (`to_peer_id` never designates it). Peers may
  **infer on the content in their own context** and act/speak in their own
  terminal, and may message **other peers** (e.g. greet a newcomer who *is* a
  real peer). `server.ts` renders these messages with explicit "do not reply to
  the sender" framing, neutralizing the protocol's "RESPOND IMMEDIATELY" rule for
  this message kind.
  - Two intents (same mechanics): **`info`** (auto join/leave, "for your
    awareness") vs **user broadcast** ("say hi to the newcomer").
- **Announce customization:** on add, a **popup free-text field** enriches the
  message. Final = i18n base template (`"{peer} ({role}) joined the group."`) +
  the user's custom text appended. Future: guided fields (Role/Objective) — for
  now a single free field.
- **Bottom broadcast field:** free text + **Send** ⇒ broadcast to all peers (or
  a selection — selection UI deferred). Covers on-demand prompts like "describe
  in 20 words what you're working on".
- **Onboarding (token-cheap):** a newcomer learns the team by calling
  `list_peers` **once** (returns each peer's `summary`) — **zero interruption to
  the others**. Seed it via an **initial prompt at launch**
  (`claude --agent … "<onboarding prompt>"`, *to verify it starts interactive,
  not print mode*); else the app pushes a message after creation.
  - **Summary staleness (verified):** `summary` is set **once at register**
    (heuristic + one background LLM upgrade, `server.ts:890`) and otherwise only
    when the peer re-calls `set_summary` — **no continuous auto-refresh**.
    Accepted trade-off: cheap passive baseline + **on-demand refresh** via the
    broadcast field when freshness matters (e.g. right after a newcomer).

## 13. Existing prototype

`desktop/` already contains a working **socle** (Electron app: PTY tiles,
maximize, persistence, a *first* peer-id reader). It is to be **reworked** to
these specs. Notable changes:
- replace the **mtime-based** peer-id heuristic with the **deterministic
  `--session-id`-based** cache file;
- add **auto-tiling display modes** (1×1 carousel / 1×2 / 2×2 / custom);
- add the **launch-command config** + **agent presets**;
- add the **scope group** injection + the **core forced-group env**;
- add the **thinking** heuristic, **resume**, and **i18n**;
- the CLI **`bin` launcher** scoped to `cwd`.

## 14. Open items to verify during implementation

1. `--session-id <uuid>` ⇒ `CLAUDE_CODE_SESSION_ID == uuid` reaches the MCP
   server (peer-id determinism). Fallback documented (§5).
2. `claude "<prompt>"` (positional) starts an **interactive** session (not
   `-p`/print) — for the onboarding seed prompt (§12).
3. node-pty rebuild for Electron on each target OS (toolchain present).
