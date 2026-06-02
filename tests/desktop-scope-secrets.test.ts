import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scope-secrets.ts imports only node builtins (the Electron safeStorage cipher
// is injected), so it imports cleanly under bun. We inject a reversible fake
// cipher to cover the keying, fallback, and corrupt-file behaviour (D8).
import {
  type SecretCipher,
  rememberScopeSecret,
  recallScopeSecret,
  forgetScopeSecret,
} from "../desktop/src/main/scope-secrets.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-secrets-"));
  tmpDirs.push(d);
  return d;
}

// Reversible fake: "encrypt" by reversing the string into a Buffer. Proves the
// stored blob is not the plaintext and that decrypt round-trips.
const fakeCipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from([...plain].reverse().join(""), "utf8"),
  decrypt: (buf) => [...buf.toString("utf8")].reverse().join(""),
};

const unavailableCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error("must not be called");
  },
  decrypt: () => {
    throw new Error("must not be called");
  },
};

test("remember then recall round-trips the secret, keyed by groupId", () => {
  const dir = freshDir();
  expect(rememberScopeSecret(dir, fakeCipher, "gid-A", "super-secret")).toBe(true);
  expect(recallScopeSecret(dir, fakeCipher, "gid-A")).toBe("super-secret");
});

test("the plaintext secret is never written to disk", () => {
  const dir = freshDir();
  rememberScopeSecret(dir, fakeCipher, "gid-A", "super-secret");
  const raw = readFileSync(join(dir, "scope-secrets.json"), "utf8");
  expect(raw).not.toContain("super-secret");
});

test("recall returns null for an unknown groupId", () => {
  const dir = freshDir();
  rememberScopeSecret(dir, fakeCipher, "gid-A", "s");
  expect(recallScopeSecret(dir, fakeCipher, "gid-OTHER")).toBeNull();
});

test("an unavailable cipher makes remember a no-op and recall null", () => {
  const dir = freshDir();
  expect(rememberScopeSecret(dir, unavailableCipher, "gid-A", "s")).toBe(false);
  expect(existsSync(join(dir, "scope-secrets.json"))).toBe(false);
  expect(recallScopeSecret(dir, unavailableCipher, "gid-A")).toBeNull();
});

test("a decrypt failure surfaces as null, not a throw", () => {
  const dir = freshDir();
  const throwingDecrypt: SecretCipher = {
    isAvailable: () => true,
    encrypt: (p) => Buffer.from(p, "utf8"),
    decrypt: () => {
      throw new Error("OS key changed");
    },
  };
  rememberScopeSecret(dir, throwingDecrypt, "gid-A", "s");
  expect(recallScopeSecret(dir, throwingDecrypt, "gid-A")).toBeNull();
});

test("a corrupt store file is treated as empty, never throws", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "scope-secrets.json"), "{ not valid json");
  expect(recallScopeSecret(dir, fakeCipher, "gid-A")).toBeNull();
  // and a subsequent remember still works (overwrites the garbage)
  expect(rememberScopeSecret(dir, fakeCipher, "gid-A", "s")).toBe(true);
  expect(recallScopeSecret(dir, fakeCipher, "gid-A")).toBe("s");
});

test("forget drops a stored secret and is a no-op when absent", () => {
  const dir = freshDir();
  rememberScopeSecret(dir, fakeCipher, "gid-A", "s");
  rememberScopeSecret(dir, fakeCipher, "gid-B", "t");
  forgetScopeSecret(dir, "gid-A");
  expect(recallScopeSecret(dir, fakeCipher, "gid-A")).toBeNull();
  expect(recallScopeSecret(dir, fakeCipher, "gid-B")).toBe("t");
  // no-op when absent
  forgetScopeSecret(dir, "gid-A");
  expect(recallScopeSecret(dir, fakeCipher, "gid-B")).toBe("t");
});
