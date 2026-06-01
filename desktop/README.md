# Claude Peers Deck

A desktop app that **docks multiple Claude Code peer sessions into a single
window**, so you stop juggling a dozen floating terminals on your desktop.

- **Left sidebar** — add / remove / rename peer terminals.
- **Right area** — every session runs live, side by side, in a tiled grid.
- **Maximize button** — blow one tile up to full size while the others keep
  running in the background.
- **Real terminals** — each tile is a true PTY (via `node-pty`), so Claude
  Code's browser OAuth and full TUI behave exactly as in a normal terminal.

Built with Electron + [xterm.js](https://xtermjs.org) + `node-pty`, the same
terminal stack that powers VS Code.

## How it works

Each tile spawns the resolved launch command (default
`claude --dangerously-load-development-channels server:claude-peers`, see
`launch-config.ts`) inside a real pseudo-terminal, with `--session-id <uuid>`
appended (and `--resume <prev> --fork-session` on restore):

- **Default (login, non-interactive)** — `"$SHELL" -l -c "<command>"` (Unix) /
  `powershell -NoLogo -NoProfile -Command "<command>"` (Windows). This keeps rc
  / profile noise out of the terminal.
- **Interactive opt-in** (`interactiveShell`) — adds `-i` (Unix) / loads the
  profile (Windows) for users whose launch command is a shell alias; a unique
  start marker is emitted and all output before it is stripped.

Shell, default project directory, grid columns, theme and font size are
configurable in **Settings** (⚙). Sessions and settings persist to the Electron
`userData` directory and are restored on launch.

### Peer id display

The app spawns every terminal with `CLAUDE_PEERS_STATUS_LINE_CACHE=1`, which
makes `claude-peers`' `server.ts` write the active `peer_id` to
`~/.claude/peers/peer-id-<cwd_key>[-<session_id>].txt`. The Deck reads those
files to show each session's live `peer_id` as a badge on its tile.

## Develop

```bash
cd desktop
npm install          # also runs electron-rebuild for node-pty
npm run dev          # launch in dev mode (HMR for the renderer)
```

If the post-install rebuild was skipped (e.g. no toolchain at install time),
run it once native build tools are available:

```bash
npm run rebuild      # electron-rebuild -f -w node-pty
```

> `node-pty` is a native module. Building it needs a C/C++ toolchain:
> **Windows** — "Desktop development with C++" (Visual Studio Build Tools);
> **macOS** — Xcode Command Line Tools; **Linux** — `build-essential` + `python3`.

### Windows build gotchas

`node-pty` hardcodes `SpectreMitigation=Spectre` in its `binding.gyp`, so the
Visual Studio toolset you build with **must** have the matching
**"MSVC … C++ x64/x86 Spectre-mitigated libs (Latest)"** component installed
(Visual Studio Installer → Individual components → search "Spectre"). Without it
the build fails with `error MSB8040`.

If `node-gyp` keeps picking the wrong toolchain (some apps register phantom
Visual Studio instances that `vswhere` reports), pin the year explicitly so it
selects your real install — set it for the build:

```powershell
$env:npm_config_msvs_version = "2019"   # or "2022", matching your VS
npm run rebuild
```

or persist it for this clone in a local, git-ignored `desktop/.npmrc`:

```
msvs_version=2019
```

(`.npmrc` is git-ignored on purpose: the right value is machine-specific and a
committed pin would break clones with a different Visual Studio.)

## Type-check & build

```bash
npm run typecheck    # tsc for main/preload + renderer
npm run build        # electron-vite production build into out/
```

## Package installers

```bash
npm run package          # current OS
npm run package:win      # NSIS installer
npm run package:mac      # dmg
npm run package:linux    # AppImage
```

## Project layout

```
src/
  main/            Electron main process
    index.ts         app lifecycle + window
    session-service.ts  session list, runtime state, peer_id polling
    pty-manager.ts   node-pty spawn/kill, OS-aware command wrapping
    peer-state.ts    resolve peer_id from the status-line cache
    store.ts         config + sessions persistence (userData JSON)
    ipc.ts           IPC handlers + event forwarding
  preload/         contextBridge -> window.api
  renderer/        React UI (sidebar, tile grid, terminal tiles, settings)
  shared/          types shared across processes
```
