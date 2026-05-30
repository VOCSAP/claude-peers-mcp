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

Each tile spawns your peer command (the `claudepeers` alias by default) inside a
real pseudo-terminal:

- **Linux / macOS** — `"$SHELL" -l -i -c "claudepeers"` so your login shell rc
  loads and the alias resolves.
- **Windows** — `powershell.exe -NoLogo -Command claudepeers` so your PowerShell
  profile loads the alias/function.

The command, shell, default project directory, grid columns, theme and font size
are all configurable in **Settings** (⚙). Sessions and settings persist to the
Electron `userData` directory and are restored on launch.

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
