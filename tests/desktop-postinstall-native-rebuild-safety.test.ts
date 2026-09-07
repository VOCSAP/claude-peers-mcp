// Card 90727c88, MEASURED on the operator's Windows machine: desktop's real
// postinstall (`electron-rebuild -f -w node-pty || echo "..."`) let a failed
// native rebuild look like a success (`|| echo` swallows the non-zero exit),
// while `-f` had already deleted build/Release before the attempt -- so the
// tree lost pty.node/conpty.node/winpty-agent.exe etc. with npm reporting 0.
// This runs the REAL postinstall string (read live from desktop/package.json,
// never copied), against a stub `electron-rebuild` on PATH that reproduces the
// measured wipe-then-fail sequence, entirely inside a scratch directory
// outside the repo -- never desktop/node_modules, never `npm install`.
// `sh` is resolved by bare PATH lookup (Bun.spawnSync, no `shell: "/bin/sh"`),
// which this host's probe confirmed works without the win32 skip other
// shell-fixture tests in this repo need for a literal `/bin/sh` path.

import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DESKTOP_ROOT = join(REPO_ROOT, "desktop");
const PACKAGE_JSON_PATH = join(DESKTOP_ROOT, "package.json");

function realPostinstallCommand(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as { scripts?: Record<string, string> };
  const cmd = pkg.scripts?.postinstall;
  if (!cmd) throw new Error("desktop/package.json has no scripts.postinstall to audit");
  return cmd;
}

/**
 * Mirrors every real desktop/scripts/*.js file the postinstall command might
 * invoke (`node scripts/<x>.js`) into the scratch tree, read live at each run
 * -- never a frozen copy, so an edit to the real script is what this test
 * exercises next time it runs, not a snapshot taken when this file was written.
 */
function mirrorRealScripts(intoDir: string): void {
  const src = join(DESKTOP_ROOT, "scripts");
  if (!existsSync(src)) return;
  const dst = join(intoDir, "scripts");
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name.endsWith(".js")) copyFileSync(join(src, name), join(dst, name));
  }
}

/** Names measured on the real incident: everything electron-rebuild -f wiped down to config.gypi. */
const NATIVE_BINARY_NAMES = ["pty.node", "conpty.node", "conpty_console_list.node", "winpty-agent.exe", "winpty.dll"];

let scratchDir: string;
let binDir: string;
let releaseDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "kory-postinstall-"));
  binDir = join(scratchDir, "fakebin");
  releaseDir = join(scratchDir, "node_modules", "node-pty", "build", "Release");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  for (const name of NATIVE_BINARY_NAMES) writeFileSync(join(releaseDir, name), `fake-existing-${name}`, "utf-8");
  writeFileSync(join(releaseDir, "config.gypi"), "{}", "utf-8");
  mirrorRealScripts(scratchDir);
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

/**
 * `mode: "fail-after-wipe"` reproduces the measured real electron-rebuild -f
 * behavior: it deletes the native binaries (but not config.gypi -- the real
 * incident's build/Release "contained only config.gypi" afterward) BEFORE
 * failing. `mode: "succeed"` writes a fresh binary and exits 0, the case a
 * genuinely healthy rebuild looks like.
 */
function writeStubElectronRebuild(mode: "fail-after-wipe" | "succeed"): void {
  const body =
    mode === "fail-after-wipe"
      ? [
          "#!/bin/sh",
          'rm -f "$(dirname "$0")/../node_modules/node-pty/build/Release/"*.node',
          'rm -f "$(dirname "$0")/../node_modules/node-pty/build/Release/"*.dll',
          'rm -f "$(dirname "$0")/../node_modules/node-pty/build/Release/"*.exe',
          'echo "Error: node-gyp failed to rebuild desktop/node_modules/node-pty" >&2',
          "exit 1",
          ""
        ].join("\n")
      : [
          "#!/bin/sh",
          'echo "fresh-binary" > "$(dirname "$0")/../node_modules/node-pty/build/Release/pty.node"',
          "exit 0",
          ""
        ].join("\n");
  const path = join(binDir, "electron-rebuild");
  writeFileSync(path, body, "utf-8");
  chmodSync(path, 0o755);
}

function runPostinstall(): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["sh", "-c", realPostinstallCommand()], {
    cwd: scratchDir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe"
  });
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/**
 * Card 90727c88 arbitration (team-lead), confirmed against .github/workflows/
 * desktop-build.yml's own documented ordering (a dedicated later "Rebuild
 * node-pty (ABI gate)" step is where a native-toolchain failure is meant to
 * turn the job red, not npm install): non-blocking stays, but loud.
 * Two independent word-boundary checks rather than one exact invented phrase:
 * an unambiguous FAILED signal, and a restoration-related word (present
 * either way desktop/scripts/rebuild-native.js's own restore() branches --
 * binaries found and restored, or none existed to restore). Neither is
 * satisfied by today's `|| echo "...skipped..."` camouflage.
 */
const FAILED_WORD_RE = /\bFAILED\b/;
const RESTORE_WORD_RE = /restor|put back|reinstat|brought back/i;

/**
 * Coverage, not just sensitivity: a check pinned to the literal word "skipped"
 * only catches TODAY's exact camouflage and lets the next one through under a
 * different verb. MEASURED with separated stdout/stderr pipes against today's
 * real `|| echo "electron-rebuild skipped (run 'npm run rebuild' manually)"`:
 * the reassuring text lands entirely on stdout, the raw tool error entirely on
 * stderr -- so stdout carrying ANY word from this family, not just "skipped",
 * is the actual defect class.
 */
const REASSURING_WORD_RE = /\b(skip(?:ped)?|ok|fine|continu(?:e|ing)|no problem|all good|ignor(?:e|ed)|note)\b/i;

test("the postinstall command prints an unambiguous failure marker on stderr instead of a soft reassuring notice, while staying non-blocking", () => {
  writeStubElectronRebuild("fail-after-wipe");
  const result = runPostinstall();
  expect(
    result.exitCode,
    `postinstall did not exit 0 on a failed native rebuild (stderr: ${result.stderr.trim()}) -- arbitrated non-blocking per the workflow's own documented ABI-gate ordering, so a failed rebuild must still let the install finish`
  ).toBe(0);
  expect(
    FAILED_WORD_RE.test(result.stderr),
    `stderr has no unambiguous FAILED signal (stderr: ${result.stderr.trim()}) -- the failure must be stated loudly on stderr, not left to the raw tool's own error text alone`
  ).toBe(true);
  expect(
    RESTORE_WORD_RE.test(result.stderr),
    `stderr does not mention restoration (stderr: ${result.stderr.trim()}) -- the operator must be told whether the pre-existing binaries were put back`
  ).toBe(true);
  expect(
    REASSURING_WORD_RE.test(result.stdout),
    `stdout contains a reassuring word (stdout: ${result.stdout.trim()}) -- a failure tolerated as non-blocking must not be reworded, under any synonym, to sound like nothing happened`
  ).toBe(false);
});

test("the postinstall command does not delete already-working binaries when the native rebuild fails", () => {
  writeStubElectronRebuild("fail-after-wipe");
  runPostinstall();
  const survivors = NATIVE_BINARY_NAMES.filter((name) => existsSync(join(releaseDir, name)));
  expect(
    survivors,
    "every pre-existing native binary was deleted by a rebuild attempt that then failed -- destruction must not precede the attempt"
  ).toEqual(NATIVE_BINARY_NAMES);
});

test("the postinstall command still succeeds and keeps a fresh binary when the native rebuild genuinely works", () => {
  writeStubElectronRebuild("succeed");
  const result = runPostinstall();
  expect(result.exitCode, `postinstall failed on a healthy rebuild (stderr: ${result.stderr.trim()})`).toBe(0);
  expect(readFileSync(join(releaseDir, "pty.node"), "utf-8")).toBe("fresh-binary\n");
});
