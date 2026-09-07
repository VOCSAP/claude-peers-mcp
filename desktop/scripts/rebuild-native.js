#!/usr/bin/env node
'use strict'

// Card 90727c88. `electron-rebuild -f` empties node-pty/build/Release BEFORE it
// rebuilds, so a rebuild that then fails leaves the tree with no terminal
// engine at all -- worse than before it ran. This wraps the attempt: copy the
// built binaries aside first, put them back if the rebuild fails, drop the copy
// if it succeeds.
//
// Exit stays 0 on failure. The CI workflow installs deps, type-checks, and only
// then runs `npm run rebuild` as its ABI gate; a non-zero postinstall would fail
// the install step and starve both later steps of a chance to run, replacing a
// red that NAMES the problem with a generic npm one.

const { spawnSync } = require('node:child_process')
const {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync
} = require('node:fs')
const { join, resolve } = require('node:path')

// From the CWD, never from __dirname: npm runs this with the package as cwd,
// and the guard test runs the real postinstall string inside a scratch tree.
const RELEASE_DIR = resolve(process.cwd(), 'node_modules', 'node-pty', 'build', 'Release')
// Outside build/Release, which `-f` wipes, and inside node_modules so it can
// never become a git candidate.
const BACKUP_DIR = resolve(process.cwd(), 'node_modules', '.node-pty-native-backup')

const REBUILD_ARGS = ['-f', '-w', 'node-pty']

function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isFile()
    } catch {
      return false
    }
  })
}

/** Everything present before the attempt, so a partial wipe restores in full. */
function backup() {
  rmSync(BACKUP_DIR, { recursive: true, force: true })
  const files = listFiles(RELEASE_DIR)
  if (files.length === 0) return []
  mkdirSync(BACKUP_DIR, { recursive: true })
  for (const name of files) cpSync(join(RELEASE_DIR, name), join(BACKUP_DIR, name))
  return files
}

/** Only what is MISSING: a file the rebuild legitimately refreshed is kept. */
function restore(files) {
  if (files.length === 0) return []
  mkdirSync(RELEASE_DIR, { recursive: true })
  const restored = []
  for (const name of files) {
    const target = join(RELEASE_DIR, name)
    if (existsSync(target)) continue
    cpSync(join(BACKUP_DIR, name), target)
    restored.push(name)
  }
  return restored
}

/**
 * Measured on Windows: a bare spawn of `electron-rebuild` answers ENOENT and a
 * `shell: true` spawn hands it to cmd.exe, which cannot run npm's extensionless
 * .bin shim. `sh -c` resolves both that shim and a POSIX one, so it goes first;
 * the shell spawn is the fallback for a Windows machine with no sh at all.
 *
 * A launcher that never starts is reported as a failure on purpose: it takes
 * the same branch as a failed rebuild, which is the safe one.
 */
function runRebuild() {
  const viaSh = spawnSync('sh', ['-c', ['electron-rebuild', ...REBUILD_ARGS].join(' ')], {
    stdio: 'inherit'
  })
  if (!viaSh.error) return viaSh.status === 0
  const viaShell = spawnSync('electron-rebuild', REBUILD_ARGS, { stdio: 'inherit', shell: true })
  return !viaShell.error && viaShell.status === 0
}

const saved = backup()
if (runRebuild()) {
  rmSync(BACKUP_DIR, { recursive: true, force: true })
  process.exit(0)
}

const restored = restore(saved)
rmSync(BACKUP_DIR, { recursive: true, force: true })
// On stderr, opening with the breakage: the operator reads one line, and a
// notice that opens with a calm word reads as a decision taken rather than as
// damage done.
const detail =
  restored.length > 0
    ? `The ${restored.length} native binaries it deleted were put back (${restored.join(', ')}), so the terminal engine keeps working with the previously built ones.`
    : 'Nothing could be put back: node_modules/node-pty/build/Release has no pty.node, and every terminal tile will fail to start.'
process.stderr.write(
  `NATIVE REBUILD FAILED: electron-rebuild could not rebuild node-pty. ${detail} ` +
    'Install the native toolchain, then run `npm run rebuild` in desktop/.\n'
)
process.exit(0)
