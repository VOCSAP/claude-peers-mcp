# Claude Peers Deck

A desktop app that **docks multiple Claude Code peer sessions into a single
window**, so you stop juggling a dozen floating terminals. Every tile is a real
terminal running a real Claude Code session; the app adds layout, an isolated
peer group, and save / restore on top.

Built with Electron + [xterm.js](https://xtermjs.org) + `node-pty` (the same
terminal stack as VS Code), and the `claude-peers` MCP channel for peer
discovery.

> Part of the [claude-peers](../README.md) project. This README covers the
> desktop app; the root README covers the MCP server, broker and CLI.

---

## What it does

- **Dock N Claude sessions in one window**, each in a true PTY, so OAuth in the
  browser, the full TUI, colours and key handling all behave exactly as in a
  normal terminal.
- **Isolated peer group per window.** Every session the window spawns shares one
  private claude-peers group, so `list_peers` inside a tile shows only this
  window's sessions, not your other Claude instances. The group secret never
  touches the repo or `ps` (a chmod-600 temp file by default).
- **Save & restore workspaces.** Close the app and reopen it; restore the
  previous session set and each tile resumes its Claude conversation.
- **English / French UI**, switchable live.

---

## Quick start

From the directory you want the peers to work in:

```bash
# one-time, from this repo:
cd desktop
npm install            # also rebuilds node-pty for Electron (see Develop)
npm link               # exposes the `claude-peers-desk` bin globally

# then, in any project:
cd /path/to/your/project
claude-peers-desk            # opens a window scoped to this directory
claude-peers-desk my-team    # optional: join/create a named (custom) shared group
```

- **No argument** -> an *ephemeral* private group (a fresh random secret each
  launch). Perfect for "just dock my sessions together on this machine".
- **A positional argument** (`my-team`) -> a *custom* group: anyone who launches
  with the same argument joins the same shared group (across PCs sharing a
  broker). The argument is the secret; choose something unguessable for real
  sharing.

You can also run it straight from the repo without linking:

```bash
cd desktop && npm run dev        # dev mode (renderer HMR)
```

---

## Using the app

### Sidebar (left)

- **`＋ Add peer`** -- start a new session in the window's project directory.
- **`▾` (advanced create)** -- a popover to pick a sub-agent (scanned from
  `.claude/agents` and `~/.claude/agents`), add free launch args (e.g.
  `--model opus`), apply a preset, choose a custom colour, and (under
  **Advanced**) run the peer in a **different working folder**. A peer launched
  in another folder still joins this window's group; only its cwd changes -- use
  with care, it can act on that folder.
- Each row shows a **colour swatch**, a **status dot** (starting / running /
  exited, with a thinking pulse), the **name** (double-click to rename) and the
  live **`peer_id`** (or `Session <id>` until it resolves).
- Per-row **maximize** and **remove** (with a confirm dialog). Drag the right
  edge to **resize** the sidebar.
- Header buttons: **🗂 Workspaces** and **⚙ Settings**.

### Tile area (right)

- **Display modes** (top bar): `1x1` carousel, `1x2`, `2x2`, or a custom
  `X x Y` grid. Overflow scrolls.
- **Maximize / restore** a tile (button, double-click its header, or
  `Ctrl+Shift+M` on the selected tile).
- The empty state offers **`＋ Add peer terminal`** and, when a previous
  workspace exists, **`Restore previous session`**.

### Workspaces (🗂) -- save & restore

A *workspace* is a restorable snapshot of the window: its session set (names,
colours, args, cwd), display mode, and the group **identity** (a `groupId`
hash -- **never the secret**). Stored in-repo at
`<project>/.claude/claude-peers/workspaces/<id>.json` (git-ignored by default).

- The live workspace **auto-saves** continuously while you work.
- **Save As** gives it a name and pins it (kept, not pruned).
- **Restore** swaps the window to a saved workspace: it adopts that workspace's
  scope and reopens its sessions. Restore is blocked when another live app owns
  that workspace's lock.
- **Restore semantics:** a session that had real activity (a transcript on disk)
  is **resumed** with its Claude context; a session that was only opened but
  never used has nothing to resume and simply **starts fresh** -- you always get
  a working terminal, never a stuck "expired" tile.

### Settings (⚙)

Project directory, launch command (global), shell override, interactive-shell
toggle, default display mode, font size, theme (dark / light), **language**
(Auto / English / Francais), and the restore-on-launch toggle.

---

## How it works

### Launch model

Each tile spawns the resolved launch command in a real pseudo-terminal:

- **Command resolution** (first wins): `<project>/.claude/claude-peers/config.json`
  -> global config (`%APPDATA%\claude-peers-desk` / XDG) -> default
  `claude --dangerously-load-development-channels server:claude-peers`.
- **Shell wrapping (default = login, non-interactive):** `"$SHELL" -l -c "<cmd>"`
  (Unix) / `powershell -NoLogo -NoProfile -Command "<cmd>"` (Windows). This keeps
  rc / profile noise out of the terminal.
- **Interactive opt-in** (`interactiveShell`): adds `-i` (Unix) / loads the
  profile (Windows) for users whose launch command is a shell alias; a unique
  start marker is emitted and output before it is stripped.

### Peer scope / group isolation

The window computes one scope (`secret`, `groupId`, display `name`) and pins
every spawned session into it via the claude-peers forced-group env
(`CLAUDE_PEERS_FORCE_GROUP[_FILE]` + `..._NAME`), fed only to the child PTY. The
secret lives in memory and a chmod-600 temp file; only the `groupId` hash is ever
persisted. An empty (freshly launched) window can **adopt** a restored
workspace's scope without relaunching.

### Sessions, ids and restore

- A new session launches with `--session-id <uuid>`; a restore forks the stored
  id (`--resume <id> --fork-session`).
- **Caveat (important):** Claude Code mints its own session id when run
  interactively with an MCP loaded, and writes its transcript only after real
  activity. The app therefore **discovers the real id in the background** (newest
  new transcript under `~/.claude/projects/<encoded-cwd>/`) and persists it, and
  on restore resumes only when a transcript exists (else starts fresh). Spawning
  is always **instant and parallel** -- discovery never blocks a terminal from
  appearing. See [`docs/debt-deferred.md`](../docs/debt-deferred.md) (D1/D2) for
  the deterministic refinement.

### Peer id display

The app spawns terminals with `CLAUDE_PEERS_STATUS_LINE_CACHE=1`, which makes
`server.ts` write the active `peer_id` to
`~/.claude/peers/peer-id-<cwd_key>[-<session_id>].txt`. The Deck reads those
files to badge each tile with its live `peer_id`.

### i18n

UI text lives in external `locales/en.json` + `locales/fr.json` (committed,
user-editable, with an embedded English fallback). The main process resolves the
locale (config or OS) and serves the dictionary to the renderer; `t(key, params)`
interpolates `{placeholder}` tokens. Changing the language re-renders live.

---

## Develop

```bash
cd desktop
npm install          # also runs electron-rebuild for node-pty
npm run dev          # launch in dev mode (renderer HMR)
```

If the post-install rebuild was skipped (no toolchain at install time), run it
once tools are available:

```bash
npm run rebuild      # electron-rebuild -f -w node-pty
```

> `node-pty` is a native module. Building it needs a C/C++ toolchain:
> **Windows** -- "Desktop development with C++" (Visual Studio Build Tools);
> **macOS** -- Xcode Command Line Tools; **Linux** -- `build-essential` + `python3`.

### Windows build gotchas

`node-pty` hardcodes `SpectreMitigation=Spectre` in its `binding.gyp`, so the
Visual Studio toolset you build with **must** have the matching
**"MSVC ... C++ x64/x86 Spectre-mitigated libs (Latest)"** component installed
(Visual Studio Installer -> Individual components -> search "Spectre"). Without it
the build fails with `error MSB8040`.

If `node-gyp` keeps picking the wrong toolchain (some apps register phantom
Visual Studio instances that `vswhere` reports), pin the year explicitly:

```powershell
$env:npm_config_msvs_version = "2019"   # or "2022", matching your VS
npm run rebuild
```

or persist it for this clone in a local, git-ignored `desktop/.npmrc`:

```
msvs_version=2019
```

(`.npmrc` is git-ignored on purpose: the right value is machine-specific and a
committed pin would break clones with a different Visual Studio.) Run native
builds from **PowerShell / cmd**, not git-bash (node-gyp's shell-outs assume
cmd.exe).

## Type-check, test & build

```bash
npm run typecheck    # tsc for main/preload + renderer
npm run build        # electron-vite production build into out/

# the pure main modules are unit-tested from the repo root:
cd .. && bun test tests/desktop-*.test.ts
```

## Package installers

```bash
npm run package          # current OS
npm run package:win      # NSIS installer
npm run package:mac      # dmg
npm run package:linux    # AppImage
```

> Packaging (pin exact electron/node-pty, copy `locales/` as `extraResources`,
> per-OS CI) is finalized in milestone M7 -- see the phase-1 plan.

---

## Project layout

```
src/
  main/                 Electron main process
    index.ts              app lifecycle, window, scope adoption, auto-save wiring
    cli-context.ts        parse argv (project cwd + optional scope id)
    scope.ts              group secret + groupId + child env (forced-group)
    launch-config.ts      resolve the launch command (project > global > default)
    agents.ts             scan .claude/agents for the create menu
    pty-manager.ts        node-pty spawn/kill, OS-aware shell wrapping
    session-command.ts    pure builder for the per-session claude command line
    shell-command.ts      pure shell-invocation builder (login vs interactive)
    session-service.ts    session list, runtime state, spawn + background id discovery
    session-transcript.ts encode cwd -> projects dir, transcript existence + discovery
    open-id-registry.ts   guard against resuming the same id twice
    peer-state.ts         resolve peer_id from the status-line cache
    workspace-store.ts    in-repo workspace JSON (save/list/load/delete)
    workspace-lock.ts     sidecar <id>.lock liveness (heartbeat / pid)
    workspace-session-map.ts  SessionDef <-> persisted WorkspaceSession
    session-close.ts      graceful close routine (/exit -> Ctrl+C -> SIGTERM)
    workspace-service.ts  orchestrates store + lock + auto-save + restore
    i18n.ts               load locales, t(key, params)
    menu.ts               tailored application menu
    store.ts              app config + sessions persistence (userData JSON)
    ipc.ts                IPC handlers + event forwarding
  preload/                contextBridge -> window.api (typed DeckApi)
  renderer/               React UI
    components/            Sidebar, CreateMenu, TileArea, TerminalTile,
                           DisplayModeBar, SettingsDialog, WorkspacesDialog, ...
    i18n.ts                renderer t() bound to the main-served dict
    store.ts               zustand store
  shared/types.ts         types shared across processes
locales/                  en.json, fr.json
bin/launch.js             the `claude-peers-desk` launcher
```

---

## Known limitations

Tracked in [`docs/debt-deferred.md`](../docs/debt-deferred.md). The most
relevant for daily use: tile <-> conversation attribution can be permuted when
many sessions in the **same folder** are restored at once (every conversation
still comes back; only the tile label may map to a different one). A
deterministic fix (a per-tile back-channel via `server.ts`) is planned.
