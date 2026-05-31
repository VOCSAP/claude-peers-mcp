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

## 1. Core change in claude-peers (prerequisite) — forced group via env

**Why:** the app must force its sessions into a chosen, isolated group without
writing project files. Today `CLAUDE_PEERS_GROUP` is low precedence and group
isolation needs a *secret* not passable by env (see `DESIGN.md` §4).

**Change** (`shared/config.ts`):
- [ ] Add a top-precedence branch in `resolveGroup` (and a helper for
  `resolveGroupName`): if `process.env.CLAUDE_PEERS_FORCE_GROUP` is set and
  non-empty, treat it as the **group secret**:
  - `secret = CLAUDE_PEERS_FORCE_GROUP`
  - `group_id = computeGroupId(secret)`
  - `group_secret_hash = computeGroupSecretHash(secret)`
  - `name = process.env.CLAUDE_PEERS_FORCE_GROUP_NAME || "forced-" + group_id.slice(0,8)`
  - This **bypasses** project files, `default_group`, and `CLAUDE_PEERS_GROUP`.
- [ ] Keep `groups_map` building intact (still include `default`).
- [ ] Document both env vars in `README.md`.
- [ ] Test: `tests/config-force-group.test.ts` — forced env wins over a present
  `.claude-peers.json`, over `default_group`, and over `CLAUDE_PEERS_GROUP`;
  produces a stable `group_id`/`secret_hash`; empty/unset env = no effect.
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

- [ ] Resolve **project cwd** = `process.cwd()` at invocation.
- [ ] Parse optional positional arg = **custom scope id**.
- [ ] Launch Electron pointing at the built `main` (or dev), passing
  `projectDir` + `scopeId` via argv/env to the main process.
- [ ] Works after `npm link` / `npm i -g .` from `desktop/`. Document in README.
- [ ] Cross-platform shebang + resolve electron binary from the local install.

## 4. Scope / group (`scope.ts`)

- [ ] If `scopeId` arg present → `secret = scopeId`; else `secret = randomUUID()`.
- [ ] Compute display root from `host` + `basename(projectDir)` (exact
  `deriveDefaultId` base algorithm, no suffix — see DESIGN §4).
- [ ] Build the **child env** for every spawned session:
  - `CLAUDE_PEERS_FORCE_GROUP = secret`
  - `CLAUDE_PEERS_FORCE_GROUP_NAME = root`
  - `CLAUDE_PEERS_STATUS_LINE_CACHE = "1"`
  - merged over `process.env` (non-invasive; child only).
- [ ] Scope is computed **once** and shared by all sessions of this launch.

## 5. Launch-command config (`launch-config.ts`)

- [ ] Resolve `launchCommand` first-wins: `<project>/.claude/claude-peers/config.json`
  → global (`%APPDATA%\claude-peers-desk\config.json` / XDG equiv) → default
  `claude --dangerously-load-development-channels server:claude-peers`.
- [ ] Schema: `{ launchCommand: string, presets?: {label,args,prompt?}[] }`.
- [ ] Create the local file on demand (UI action), never silently.
- [ ] Global config editable from the Settings dialog.

## 6. PTY + sessions (`pty-manager.ts`, `session-service.ts`)

- [ ] **Spawn** a session: mint `uuid`, build argv =
  `<launchCommand tokens> --session-id <uuid> [extraArgs]`, wrap in the login/
  interactive shell (Unix: `$SHELL -l -i -c "<cmd>"`; Windows:
  `powershell -NoLogo -Command "<cmd>"`), `cwd = session.cwd`, `env` from §4.
- [ ] **Restore**: same but `--resume <uuid>` + original `extraArgs`.
- [ ] Persist `{ uuid, name, cwd, args, createdAt }` per session.
- [ ] Runtime state per session: `starting | running | exited`, pid, peerId,
  thinking (bool).
- [ ] Events to renderer: `pty:data`, `pty:exit`, `sessions:changed`,
  `session:thinking`.
- [ ] Resize via fit addon → `pty:resize`.

## 7. peer_id (`peer-state.ts`)

- [ ] Deterministic: read `~/.claude/peers/peer-id-<cwdKey>-<uuid>.txt`
  (`cwdKey` per existing `computeCwdKey`). Poll until present, then cache.
- [ ] Fallback (if §14.1 verification fails): newest `peer-id-<cwdKey>-*.txt`.
- [ ] Until resolved, UI shows `Session <uuid[:8]>`.

## 8. Thinking heuristic (`thinking.ts`)

- [ ] Tap the PTY output stream; detect busy markers (spinner / "esc to
  interrupt") vs idle (prompt). Debounce. Emit `session:thinking {id, busy}`.
- [ ] Isolated module so the detection rules can be tuned per Claude version.
- [ ] Renderer shows a dot/icon in first position of each sidebar row + tile.

## 9. UI (renderer)

- [ ] **Sidebar**: list rows `[thinking][peer_id]`; `+` (quick create in project
  scope) with `▾` → **CreateMenu** (agent dropdown from `.claude/agents`, free
  args field, presets); delete with **ConfirmDialog**; single-click select.
- [ ] **TileArea + DisplayModeBar**: modes 1×1 carousel (horizontal scroll +
  wheel), 1×2, 2×2, custom X×Y (free inputs). Overflow scrollable.
- [ ] **Selection/maximize**: single-click highlights; double-click toggles
  fullscreen (single slot); per-tile maximize/reduce button. All PTYs stay
  alive when hidden; refit on visibility/size change.
- [ ] **SettingsDialog**: launch command, locale, theme, font size, columns
  defaults, restore-on-launch.
- [ ] All strings via `t()` (§10).

## 10. i18n (`i18n.ts` main + renderer)

- [ ] Load `locales/<lang>.json` from app dir; merge user-override dir on top.
- [ ] `t(key, params)` with `{placeholder}` interpolation.
- [ ] Ship `en.json` + `fr.json`; not bundled (read at runtime / copied as
  resources, user-editable). Expose locale + dict to renderer via IPC/preload.

## 11. Persistence & Restore (`workspace-store.ts`, `workspace-lock.ts`)

See DESIGN §6 for the full rationale and verified Claude facts.

**Storage & model**
- [ ] Workspace JSON in-repo: `<project>/.claude/claude-peers/workspaces/<id>.json`
  (schema in DESIGN §6.3: id, name, pinned, cwd, scopeSecret, scopeName,
  displayMode, sessions[]).
- [ ] Discovery = list that one dir. Ensure a `.gitignore` in
  `.claude/claude-peers/` (workspaces hold the scope secret).
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
- [ ] New-id capture: if `--session-id`-on-fork is honoured (verify, DESIGN §14.2)
  → mint & know it; else **discover** post-spawn via `peer-id-<cwdKey>-<newId>.txt`
  (or newest `~/.claude/projects/<project>/*.jsonl`). **Persist the new id.**
- [ ] During restore, spawn sessions **sequentially** to capture each new id.

**Restore flows (DESIGN §6.6)**
- [ ] Startup picker: **New** / **Restore** (list for cwd: name, updatedAt,
  count, lock state). Empty app **adopts** the saved scope (no self-relaunch).
- [ ] Restore while running: warn + offer Save → **graceful close** routine
  (`/exit\n` → `Esc`/`Ctrl+C` → SIGTERM) → adopt new scope → reopen.
- [ ] Expired session: **React overlay** on the tile ("session expired — [Start
  new]") spawning `--session-id <new>` + stored `args`; plus a global "start
  all".
- [ ] **File menu**: New / Save / Save As (name) / Restore.

## 12. Packaging

- [ ] electron-builder targets (win/mac/linux); `asarUnpack` node-pty.
- [ ] `postinstall` electron-rebuild for node-pty; document toolchain needs.

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
