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
- **Injection:** a **new top-precedence forced-group path** in the claude-peers
  core, fed per child process via node-pty's `env` option (**non-invasive**:
  affects only the spawned terminal, never the user's shell, global env, or any
  project file). Needed because the existing `CLAUDE_PEERS_GROUP` is **near-last**
  in `resolveGroupName` precedence and group **isolation requires a secret** that
  cannot be passed today. Two transport options (see §15 and Phase 1 §"Core change"):
  - **env var** `CLAUDE_PEERS_FORCE_GROUP` (the secret) + `CLAUDE_PEERS_FORCE_GROUP_NAME`
    (display label) — simplest, but the secret is visible in `/proc/<pid>/environ`;
  - **file** `CLAUDE_PEERS_FORCE_GROUP_FILE` pointing to a `chmod 600` file holding
    the secret — keeps the secret out of the environment (preferred if the small
    `server.ts` read stays cheap).
  Both **override** project files, `default_group`, and `CLAUDE_PEERS_GROUP`.
- **The secret is never persisted in the workspace JSON** (see §6.3/§6.8): only
  the `group_id` (sha256) is stored. Default scopes are **ephemeral** (a fresh
  scope is minted on restore; sessions still rediscover each other); custom
  scopes are **re-supplied** via the launch arg (optionally cached in the OS
  keychain via Electron `safeStorage`).
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

## 6. Persistence & Restore (decided)

> The session UUID is **never typed by the user**. `--resume`/`--fork-session`
> are the app's **internal** per-tile mechanism, replayed from stored state.
> The user interacts only through the UI (a **File ▸ Save / Restore** menu and
> auto-save).

### 6.1 Verified Claude Code facts that shape this design

- `--resume <id>` on a **missing** id → **errors** ("No conversation found"),
  non-zero exit (does **not** start a new session).
- **Concurrent resume corrupts**: resuming the same id in two terminals
  interleaves both into one transcript — **no lock, no warning** (documented).
  ⇒ collision avoidance is **mandatory** and is ours to implement.
- `--fork-session` (requires `--resume`/`--continue`) **copies the full history
  into a NEW id and leaves the original untouched**.
- **Agent and model are persisted** in the transcript and **auto-restored** on
  resume ⇒ no need to re-pass `--agent`/`--model` when resuming.
- Sessions are **scoped to the project directory** (`~/.claude/projects/<project>/<id>.jsonl`)
  ⇒ each session must be resumed **from its original cwd**.
- **30-day default retention** (`cleanupPeriodDays`) ⇒ old sessions expire and
  stop resolving.

### 6.2 Fork-on-every-resume (collision avoidance)

Every resume path — explicit free-form `--resume` in advanced-create **and**
workspace restore — uses **`--fork-session`**: it forks the stored id into a
**new** id that the app **persists** for the next cycle (id lineage
id0→id1→id2…; old ids become dead branches, purged by the 30-day cleanup).
Because each open mints a fresh id, **two terminals never share an id** — even
if the user separately resumed the original outside the app. Minor transcript
proliferation is the accepted cost.

- **New session (not a restore):** `--session-id <uuid>` (nothing to fork from).
- **Resume/restore:** `--resume <prevId> --fork-session [--session-id <newUuid>]`.
- **Knowing the new id (two-track, decided up front):** a one-time **capability
  probe** at first launch tests whether `--session-id` is honoured on a fork
  (§14). The result drives `session-service.ts`:
  - **deterministic track** (honoured) → ids known in advance → **parallel spawn**
    (instant restore), deterministic peer-id cache;
  - **discovery track** (ignored) → **discover** the new id right after spawn via
    `peer-id-<cwdKey>-<newId>.txt` (suffix = new id, content = peer_id — both at
    once) or the newest `~/.claude/projects/<project>/*.jsonl`. Spawn is
    **sequential only within the same cwd** (same `cwdKey` = ambiguous files);
    **parallel across distinct cwds**.
- **Resume passes only `--resume`/`--fork-session`** (agent/model auto-restored);
  stored `args` are kept for display and for the expired-session fallback (§6.6).

### 6.3 Workspace model (the persisted unit)

A **workspace** = a restorable snapshot:
```jsonc
{
  "id": "wsp_…", "name": "Team feature-X", "pinned": false,
  "cwd": "/abs/project", "groupId": "<sha256 hex>", "scopeName": "olivier-pc-foo",
  "scopeKind": "ephemeral",                // or "custom" ⇒ re-supplied via launch arg
  "displayMode": { "kind": "grid", "x": 2, "y": 2 },
  "createdAt": 0, "updatedAt": 0,
  "sessions": [
    { "claudeSessionId": "…", "name": "reviewer", "cwd": "/abs/project",
      "args": ["--agent","reviewer"], "color": "#4488ff", "position": 0 }
  ]
}
```
> **No `scopeSecret`** — only `groupId` for display/identification (see §6.8).

### 6.4 Storage & discovery (in-repo)

- Stored **in the project**: `<project>/.claude/claude-peers/workspaces/<id>.json`.
  Discovery = **list one directory** (no global scan). Consistent with the
  launch-command config location.
- **No secret is stored** (only `groupId`), so a leaked/synced workspace cannot
  join the group. The dir is still **git-ignored by default** (session ids +
  layout are machine/project-local noise); the app maintains a `.gitignore`.
  Community sharing of sanitized "team templates" (no ids) is a Phase 2 export.

### 6.5 Locking (mandatory, per §6.1)

- An app that owns a workspace holds a **lock**: sidecar `<id>.lock` with
  `{ pid, host, startedAt, heartbeat }`.
- Restore refuses a workspace whose lock is held by a **live** owner; reclaims a
  **stale** one. **Same-host** liveness = `process.kill(pid,0)` → **reliable, no
  clock issue** (the targeted Phase 1 case). **Cross-host** relies on heartbeat
  freshness across two clocks → **best-effort only** (documented §15); a robust
  cross-host lock would delegate to the broker (single authoritative clock) — a
  Phase 2 enhancement.
- Belt-and-suspenders: an **open-session-id registry** prevents resuming the
  same id from two workspaces.

### 6.6 Scope adoption & restore flows

- **Scope is fixed only once the first session spawns.** It is a value the main
  process holds and injects per spawn — so a freshly-opened (empty) app can
  **adopt** a workspace's saved scope at restore with **no self-relaunch**.
- **Launch + restore (empty app):** picker shows **New** / **Restore** (list of
  workspaces for the current cwd, with name, updatedAt, session count, lock
  state). Restore → adopt saved scope, set display mode, spawn sessions
  (sequentially, fork-on-resume).
- **Restore while sessions are running:** warn "current sessions will be
  closed", offer **Save first**. On confirm → **graceful close** of each session
  (write `"/exit\n"`; if still alive after ~1.5 s, send `Esc`/`Ctrl+C`, retry
  `"/exit\n"`; last resort SIGTERM — peer side cleaned by `server.ts`) → adopt
  new scope → reopen. (Alternative "open in a new window" = relaunch a second
  app process — possible later.)
- **Expired session at restore:** when `--resume` fails ("No conversation
  found"), the tile shows a **React overlay** ("session expired — [Start a new
  session]") that spawns a fresh `--session-id <new>` with the stored `args`
  (re-applying `--agent`). A global "start all" is offered. (UI overlay, not text
  written into the terminal buffer.)

### 6.7 Auto-save, naming, explorable list

- **Continuous auto-save** of the live workspace (unique id, scope, cwd) with an
  auto name (e.g. `auto — olivier-pc-foo — 14:32`).
- **Explicit Save** lets the user **name** it; the same record then persists
  under that name and is marked `pinned` (kept, not pruned).
- The **Restore picker lists all** workspaces for the cwd (name, date, session
  count, lock state) — answers "which is the latest?" when several apps ran on
  the same cwd.
- Optional pruning of **unpinned**, closed auto-saves older than N days
  (aligned with Claude's 30-day retention).

### 6.8 Secret handling (security)

- The workspace **never stores the scope secret** — only `groupId` (§6.3).
- **Default (ephemeral) scope:** on restore, mint a **fresh** secret/scope. The
  restored sessions get new forked ids and **rediscover each other** in the new
  scope; there were no external members, so nothing is lost. Nothing to persist.
- **Custom scope:** the secret is the **user-supplied launch arg** — to rejoin
  the same shared group, relaunch with the same arg. Optionally cache it on the
  machine via Electron **`safeStorage`** (OS-keychain-backed; no `keytar` native
  dep) for a "remember on this machine" convenience — never written to the repo.

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

**Command execution (decided):** by default the command is run **directly / via
a login shell `-l -c` (no `-i`)** — *not* an interactive shell — to avoid
`.bashrc`/`.zshrc` noise (oh-my-zsh, NVM, conda, pyenv) polluting the PTY. Since
the launch-command **is** the indirection, no shell alias is needed. An **opt-in
"interactive shell"** mode (`-i`) remains for users who must resolve a shell
alias; in that mode the app emits a **unique start marker** before the command
and **discards rc output before the marker**. (Details in Phase 1 §"PTY +
sessions".)

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

- **Left menu (resizable by drag, min/max width, persisted):** session list;
  create (`+` with `▾` for advanced), delete **with confirmation**.
  - Row = `[color swatch + thinking dot] [session name — primary, editable,
    ellipsis]`, with the **peer_id as secondary** (dim, ellipsis, full on
    tooltip). Colour/name never the sole carrier of info (accessibility).
- **Single click** = select/highlight the session in the tiles area.
- **Fullscreen toggle** (single slot) is triggered by the per-tile **`⤢`
  button**, a **keyboard shortcut** (e.g. `Ctrl+Shift+M`), or a **double-click on
  the tile *title bar*** — **never** a double-click on the xterm body (that is
  reserved for the terminal's own word selection). Double-click in the
  **sidebar** also toggles fullscreen (no xterm there).
  - same target again ⇒ reduce; another ⇒ previous reduces, new expands.
- **Display-mode selector** for the tiles area:
  - **1×1 "carousel"**: one full-size session, navigate horizontally between
    conversations (scrollbar + mouse wheel);
  - **1×2**, **2×2**;
  - **Custom X×Y**: free input of columns × rows; the grid shows X·Y cells and
    overflow is scrollable.
  - Maximize/fullscreen overrides the current mode.
- **Thinking indicator** (leading position on each row): see §10.
- **Per-agent colors:** each session gets a colour — **auto-assigned** from a
  rotating palette of ~8–12 perceptually-distinct, dark/light-safe (ideally
  colorblind-safe) hues, **overridable** via a colour picker (wider palette). The
  colour frames the **tile border/header** and the **sidebar swatch** — **not**
  the xterm background (readability). Persisted per session (`color`) and
  restored. Always paired with the name (never colour-only).

## 10. "Thinking" indicator (decided)

- No public API/env exposes Claude's busy/idle state (verified).
- **Phase 1 = placeholder, explicitly temporary:** a heuristic over the PTY
  output (spinner / "esc to interrupt"). It is **non-deterministic** (the stream
  mixes UI chrome and Claude-generated content that may contain the same strings,
  and varies across `--agent`/interactive/`--print`). Shipped only as a first
  approximation, **to be replaced** — not the final solution.
- **Real solution (Phase 2): hooks.** Inject `UserPromptSubmit` (turn start) +
  `Stop` (turn end) hooks for the app's sessions that write a busy/idle state to
  a per-session file the app watches → deterministic. Open question: the
  **injection mechanism** without polluting the user's config (verify a
  `--settings <file>` flag, or a gitignored `.claude/settings.local.json`).

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
2. **`--session-id <new>` combined with `--resume <old> --fork-session`** — is
   the new id honoured? Determines deterministic vs discovery path (§6.2).
   *Undocumented; must be tested.* Discovery fallback works either way.
3. `--agent`/`--model` are auto-restored on resume (documented) — confirm the
   resumed tiles keep their agent/model without re-passing the flags.
4. `claude "<prompt>"` (positional) starts an **interactive** session (not
   `-p`/print) — for the onboarding seed prompt (§12).
5. node-pty rebuild for Electron on each target OS (toolchain present).

## 15. Security & known limitations

- **Scope secret in process env:** if the env transport (§4) is used, the secret
  is visible in `/proc/<pid>/environ` to the current user (and possibly
  monitoring tools). Low risk for solo use; **documented in the README**. For
  shared/multi-user machines, prefer the **file transport** (§4) or a future
  authenticated local socket. Further mitigated by §6.8 (default scopes are
  ephemeral; custom secrets are already user-known).
- **Workspace files hold no secret** (§6.3/§6.8) — only `group_id`. A leaked or
  cloud-synced workspace cannot join the group.
- **Cross-host workspace lock is best-effort** (clock-skew dependent, §6.5).
  Same-host locking is reliable. Robust cross-host exclusion is a Phase 2
  broker-arbitrated enhancement.
- **node-pty native rebuild** is required per Electron version / OS / arch — see
  the Phase 1 packaging/DX task (pinned versions, `electron-rebuild`, per-OS CI).
