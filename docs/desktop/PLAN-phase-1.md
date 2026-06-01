# Phase 1 — Implementation Plan (the functional app)

> Read `DESIGN.md` first. This plan is implementation-ready and tracked with
> checkboxes. Phase 2 (collaboration) lives in `PLAN-phase-2.md`.
> Goal of Phase 1: a usable app — dock sessions, scope them, resume them.

## 0. Scope of Phase 1

In: CLI launcher scoped to `cwd`; create/delete/select sessions; auto-tiling
display modes (1×1 carousel / 1×2 / 2×2 / custom X×Y) + maximize; arbitrary
launch args (incl. `--agent`) + agent presets; deterministic `--session-id` +
peer_id display; per-launch scope group (+ core forced-group env); thinking
heuristic (approach B); launch-command config (local→global→default); i18n
framework (en+fr); persist & restore (resume via `--session-id`).

Out (→ Phase 2): `/announce`, broadcast field, no-reply message kind,
onboarding via summaries, agent dropdown polish, destinatary selection.

## 1. Core change in claude-peers (prerequisite) — forced group via env/file

**Why:** the app must force its sessions into a chosen, isolated group without
writing project files. Today `CLAUDE_PEERS_GROUP` is low precedence and group
isolation needs a *secret* not passable by env (see `DESIGN.md` §4).

**Change** (`shared/config.ts`):
- [ ] Add a top-precedence branch in `resolveGroup` (and `resolveGroupName`):
  resolve the forced **group secret** from, in order, `CLAUDE_PEERS_FORCE_GROUP`
  (env) **or** the contents of `CLAUDE_PEERS_FORCE_GROUP_FILE` (a `chmod 600`
  file — keeps the secret out of `/proc/<pid>/environ`, DESIGN §15). If found:
  - `group_id = computeGroupId(secret)`
  - `group_secret_hash = computeGroupSecretHash(secret)`
  - `name = CLAUDE_PEERS_FORCE_GROUP_NAME || "forced-" + group_id.slice(0,8)`
  - This **bypasses** project files, `default_group`, and `CLAUDE_PEERS_GROUP`.
- [ ] **Inject the forced `{ [name]: group_id }` into the returned `groups_map`**
  (alongside `default`). Without it, `server.ts:groupNameForId` does not find the
  forced `group_id` in the map and falls back to the `<unknown>` sentinel in
  `whoami` / `list_peers` / `list_groups`. (Verified: `groupNameForId` iterates
  `myGroupsMap` and has no other source for the display name.)
- [ ] Keep the rest of `groups_map` building intact (still include `default`
  and the user-config `groups`).
- [ ] Document both env vars in `README.md`.
- [ ] Test: `tests/config-force-group.test.ts` — forced secret (env **or** file)
  wins over a present `.claude-peers.json`, over `default_group`, and over
  `CLAUDE_PEERS_GROUP`; stable `group_id`/`secret_hash`; unset = no effect; env
  takes precedence over file when both set; **`groups_map[name] === group_id`**
  for the forced group (so the display name resolves, not `<unknown>`).
- [ ] `bun test` green; smoke build green (`bun build --target=bun broker.ts
  server.ts cli.ts`).

> This is the **only** change to the existing claude-peers core in Phase 1. It
> is additive and backward-compatible.

## 2. Desktop app — module layout (rework of `desktop/`)

```
desktop/
  bin/launch.js              # CLI entry on PATH; resolves cwd, spawns Electron
  package.json               # "bin": { "claude-peers-desk": "./bin/launch.js" }
  src/
    main/
      index.ts               # app lifecycle + window
      cli-context.ts         # parse argv (scope id), resolve project cwd
      scope.ts               # group secret (uuid|arg) + display root; env builder
      launch-config.ts       # resolve launchCommand: local → global → default
      agent-presets.ts       # read presets from launch-config; scan .claude/agents
      pty-manager.ts         # node-pty spawn/kill, OS-aware command wrapping
      session-service.ts     # session list, runtime state, --session-id, fork-resume
      peer-state.ts          # peer-id + new-id discovery from cache file
      thinking.ts            # heuristic busy/idle detector over PTY output
      workspace-store.ts     # in-repo workspace JSON: save/list/load/auto-save
      workspace-lock.ts      # <id>.lock acquire/heartbeat/reclaim + open-id registry
      session-close.ts       # graceful close routine (/exit → Ctrl+C → SIGTERM)
      store.ts               # app UI/state + global app config (userData)
      ipc.ts                 # IPC handlers + event forwarding
      i18n.ts                # load locale files (app dir + user override)
    preload/
      index.ts               # contextBridge -> window.api
      index.d.ts
    renderer/
      index.html
      src/
        main.tsx
        store.ts             # zustand store
        i18n.ts              # renderer-side t() bound to main's locale data
        components/
          App.tsx
          Sidebar.tsx        # list, create (+ ▾), delete (confirm), select
          CreateMenu.tsx     # advanced create: agent + free args + presets
          TileArea.tsx       # display-mode container (carousel/grid/custom)
          TerminalTile.tsx   # xterm + fit + maximize/reduce + thinking dot
          DisplayModeBar.tsx # 1×1 / 1×2 / 2×2 / custom X×Y selector
          SettingsDialog.tsx # launch cmd, locale, theme, font, restore…
          ConfirmDialog.tsx
    shared/
      types.ts               # shared types across processes
  locales/
    en.json
    fr.json
  electron.vite.config.ts
  electron-builder.yml
  tsconfig*.json
  README.md
```

## 3. CLI launcher (`bin/launch.js`)

- [x] Resolve **project cwd** = `process.cwd()` at invocation.
- [x] Parse optional positional arg = **custom scope id**.
- [x] Launch Electron pointing at the built `main` (or dev), passing
  `projectDir` + `scopeId` via argv/env to the main process.
- [ ] Works after `npm link` / `npm i -g .` from `desktop/`. Document in README.
  (`bin` field added; manual install + README doc pending.)
- [x] Cross-platform shebang + resolve electron binary from the local install.

## 4. Scope / group (`scope.ts`)

- [x] `scopeId` arg present → `secret = scopeId`, `scopeKind = "custom"`; else
  `secret = randomUUID()`, `scopeKind = "ephemeral"`.
- [x] Compute display root from `host` + `basename(projectDir)` (exact
  `deriveDefaultId` base algorithm, no suffix — see DESIGN §4).
- [x] Provide the secret to each spawned session via **env or file** transport
  (`CLAUDE_PEERS_FORCE_GROUP[_FILE]` + `CLAUDE_PEERS_FORCE_GROUP_NAME`) plus
  `CLAUDE_PEERS_STATUS_LINE_CACHE=1`, merged over `process.env` (child only).
  Prefers the chmod-600 file transport, falls back to the env var on FS failure.
- [~] Persist **only `groupId`** (sha256) in the workspace, never the secret
  (DESIGN §6.8). On restore: ephemeral → mint a fresh scope; custom → re-supplied
  via arg (optional `safeStorage` cache). (Secret is never persisted today;
  workspace persistence + restore lands in M6.)
- [~] Scope computed **once**, shared by all sessions; fixed only once the first
  session spawns (adoptable at restore while empty). (Computed once at launch;
  restore-time adoption lands in M6.)

## 5. Launch-command config (`launch-config.ts`)

- [x] Resolve `launchCommand` first-wins: `<project>/.claude/claude-peers/config.json`
  → global (`%APPDATA%\claude-peers-desk\config.json` / XDG equiv) → default
  `claude --dangerously-load-development-channels server:claude-peers`.
- [x] Schema: `{ launchCommand: string, presets?: {label,args,prompt?}[] }`.
- [~] Create the local file on demand (UI action), never silently.
  (`createLocalConfig` exists; the UI action lands in M5.)
- [x] Global config editable from the Settings dialog (launch command).

## 6. PTY + sessions (`pty-manager.ts`, `session-service.ts`)

- [x] **Command execution (default = no interactive shell):** run the configured
  command **directly**, or via a **login** shell `-l -c` (Unix) /
  `powershell -NoLogo -NoProfile -Command` (Windows). **Avoid `-i`** by default
  (rc noise -- oh-my-zsh/NVM/conda/pyenv pollutes the PTY, DESIGN §7).
- [x] **Opt-in interactive mode** (`-i`) for shell-alias users: emit a unique
  **start marker** before the command and **strip all PTY output before it**
  (with a buffer cap so output is flushed if the marker never appears).
- [x] **New session:** argv = `<cmd tokens> --session-id <uuid> [extraArgs]`,
  `cwd = session.cwd`, env/secret-file from §4.
- [x] **Resume/restore (fork-on-resume):** `--resume <prevId> --fork-session
  --session-id <newUuid>`; do **not** re-pass `--agent`/`--model` (auto-restored);
  mint & persist the new id up front (deterministic, verified §14.2; discovery
  fallback only on CC regression -- see §11).
- [x] Persist `{ uuid (sessionId), name, cwd, args, createdAt }` per session.
- [x] Runtime state per session: `starting | running | exited`, pid, peerId,
  thinking (bool).
- [x] Events to renderer: `pty:data`, `pty:exit`, `sessions:changed`,
  `session:thinking`.
- [x] Resize via fit addon → `pty:resize`.

## 7. peer_id (`peer-state.ts`)

- [x] Deterministic: read `~/.claude/peers/peer-id-<cwdKey>-<uuid>.txt`
  (`cwdKey` per existing `computeCwdKey`). Poll until present, then cache.
- [x] Fallback (if §14.1 verification fails): newest `peer-id-<cwdKey>-*.txt`.
- [~] Until resolved, UI shows `Session <uuid[:8]>`. (main exposes `peerId: null`
  until resolved; the placeholder label is a renderer concern, M5.)

## 8. Thinking heuristic (`thinking.ts`) — PLACEHOLDER (to be replaced)

> Explicitly temporary (DESIGN §10). Non-deterministic; the real, hook-based
> solution lands in Phase 2.

- [x] Tap the PTY output stream; detect busy markers (spinner / "esc to
  interrupt") vs idle. Debounce. Emit `session:thinking {id, busy}`.
- [x] Isolated module so rules can be tuned per Claude version / swapped out.
- [x] Renderer shows a (pulsing) dot in the leading position of each sidebar row + tile.

## 9. UI (renderer)

- [x] **Sidebar (resizable by drag, persisted width):** rows = `[colour swatch +
  thinking dot] [editable name — primary] / [peer_id — secondary, dim, tooltip]`;
  `+` (quick create) with `▾` → **CreateMenu** (agent dropdown from
  `.claude/agents`, free args, presets, optional colour, advanced folder); delete
  with **ConfirmDialog**; single-click select. (Note: row double-click edits the
  name; tile-title double-click toggles fullscreen.)
- [x] **TileArea + DisplayModeBar**: modes 1×1 carousel (horizontal scroll +
  wheel), 1×2, 2×2, custom X×Y (free inputs). Overflow scrollable. Each tile is
  **framed in its session colour** (head accent); xterm background untouched.
- [x] **Fullscreen**: per-tile `⤢` button + shortcut (`Ctrl+Shift+M`) +
  double-click **on the tile title bar only** (never the xterm body). All PTYs
  stay alive when hidden; refit on visibility/size change.
- [x] **Colour**: auto-assign from a rotating 10-colour palette; user override via a
  colour picker; persisted per session.
- [~] **SettingsDialog**: launch command, locale, theme, font size, default
  display mode, restore behaviour, palette. (Done: launch command (global),
  theme, font, default display mode, restore, shell, interactive. Pending:
  locale (M6 i18n), palette editor.)
- [ ] All strings via `t()` (§10).

## 10. i18n (`i18n.ts` main + renderer)

- [x] Load `locales/<lang>.json` from app dir; merge user-override dir on top.
  (`main/i18n.ts loadDict` layers EN_DEFAULTS < shipped en < shipped lang <
  user en < user lang; shipped dir = resources when packaged / `app.getAppPath()`
  in dev, user dir = `userData/locales`.)
- [x] `t(key, params)` with `{placeholder}` interpolation (missing key -> key,
  missing param -> token left verbatim).
- [x] Ship `en.json` + `fr.json` (committed, identical key sets). Read at runtime;
  embedded `EN_DEFAULTS` is the last-resort fallback (parity-tested vs en.json).
  Expose locale + dict to renderer via IPC `i18n:get` / preload `getI18n`;
  renderer `useT()` re-renders on locale change. Locale selector in Settings
  (`locale: '' | 'en' | 'fr'`, `''` = OS-derived). (Packaging `extraResources`
  copy of `locales/` deferred to M7.)

## 11. Persistence & Restore (`workspace-store.ts`, `workspace-lock.ts`)

See DESIGN §6 for the full rationale and verified Claude facts.

**Storage & model**
- [ ] Workspace JSON in-repo: `<project>/.claude/claude-peers/workspaces/<id>.json`
  (schema in DESIGN §6.3: id, name, pinned, cwd, **`groupId`** (sha256),
  scopeName, **`scopeKind`** ("ephemeral" | "custom"), displayMode,
  sessions[]). **No `scopeSecret` is ever persisted** (DESIGN §6.3/§6.8): only
  `groupId` for display/identification. On restore, ephemeral scopes mint a
  fresh secret; custom scopes are re-supplied via the launch arg (optional
  `safeStorage` cache, never the repo).
- [ ] Discovery = list that one dir. Maintain a `.gitignore` in
  `.claude/claude-peers/` — **not because the files hold a secret** (they do
  not), but because session ids + layout are machine/project-local noise. A
  leaked or cloud-synced workspace cannot join the group (no secret inside).
- [ ] **Auto-save** the live workspace continuously (unique id, auto name);
  **explicit Save** sets a user name + `pinned`. Optional prune of unpinned
  closed auto-saves > N days.

**Locking (mandatory)**
- [ ] On owning a workspace, write sidecar `<id>.lock { pid, host, startedAt,
  heartbeat }`; refresh heartbeat. Release on close.
- [ ] Restore refuses a workspace whose lock is held by a live owner (pid alive
  same-host / fresh heartbeat); reclaim stale locks (mirror broker liveness).
- [ ] Maintain an **open-session-id registry** to block resuming the same id
  from two workspaces.

**Fork-on-every-resume (collision avoidance, DESIGN §6.2)**
- [ ] New session: `--session-id <uuid>`. Resume/restore:
  `--resume <prevId> --fork-session [--session-id <newUuid>]`.
- [ ] Resume passes **only** `--resume`/`--fork-session` (agent/model
  auto-restored); keep stored `args` for display + expired fallback.
- [ ] New-id capture: **deterministic by default** — `--session-id`-on-fork IS
  honoured (verified DESIGN §14.2, CC 2.1.158), so **mint & know the new id up
  front** and **persist it**. No post-spawn discovery needed in the common case.
  - *Forward-compat fallback (implement only if a future CC regresses):* discover
    post-spawn via `peer-id-<cwdKey>-<newId>.txt` (or newest
    `~/.claude/projects/<project>/*.jsonl`), with a one-time capability probe to
    detect the regression.
- [ ] During restore, spawn sessions **in parallel** (ids known up front). The
  sequential-per-cwd path belongs to the discovery fallback only.

**Restore flows (DESIGN §6.6)**
- [ ] Startup picker: **New** / **Restore** (list for cwd: name, updatedAt,
  count, lock state). Empty app **adopts** the saved scope (no self-relaunch).
- [ ] Restore while running: warn + offer Save → **graceful close** routine
  (`/exit\n` → `Esc`/`Ctrl+C` → SIGTERM) → adopt new scope → reopen.
- [ ] Expired session: **React overlay** on the tile ("session expired — [Start
  new]") spawning `--session-id <new>` + stored `args`; plus a global "start
  all".
- [ ] **File menu**: New / Save / Save As (name) / Restore.

## 12. Packaging & native-build DX

- [ ] **Pin exact versions** of `electron` and `node-pty` (no `^`): every Electron
  bump changes the V8/ABI and forces a node-pty rebuild (DESIGN §15).
- [ ] `@electron/rebuild` in `postinstall` + explicit `npm run rebuild`; document
  per-OS toolchain (VC++ Build Tools / Xcode CLT / build-essential+python3) and
  macOS arm64↔x64 arch matching.
- [ ] **Per-OS CI** build to catch rebuild breakage early.
- [ ] electron-builder targets (win/mac/linux); `asarUnpack` node-pty.

## 13. Validation (definition of done, Phase 1)

- [ ] Core: `bun test` green incl. new force-group test; smoke build green.
- [ ] App: `npm run typecheck` + `electron-vite build` green.
- [ ] Manual (target machine): launch `claude-peers-desk` in a project →
  window opens scoped to cwd; create 2-3 sessions → they tile and run; OAuth
  works in a tile; peer_id badges resolve; `list_peers` inside a session shows
  only the app's sessions (scope isolation); maximize/reduce works; switch
  display modes (incl. custom X×Y); quit & relaunch → sessions resume with same
  context (`--resume`); change locale → UI switches.
- [ ] Verify open items DESIGN §14.1 and §14.2; record results in DESIGN.

## 14. Suggested commit sequence

1. core: forced-group env + test + README.
2. desktop: bin launcher + cli-context + scope + env injection.
3. desktop: launch-config + pty/session rework + `--session-id`/resume.
4. desktop: deterministic peer-id + thinking heuristic.
5. desktop: display modes + sidebar/create/confirm + settings.
6. desktop: i18n (en/fr) + persistence/restore.
7. packaging + README + validation notes.
