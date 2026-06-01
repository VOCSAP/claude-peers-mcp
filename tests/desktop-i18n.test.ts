import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// i18n.ts only imports node builtins (no electron), so it imports cleanly under
// bun. Covers interpolation, missing-key/param fallbacks, dir layering, OS-locale
// resolution, and the en.json <-> EN_DEFAULTS parity guard.
import {
  EN_DEFAULTS,
  loadDict,
  resolveLocale,
  t,
} from "../desktop/src/main/i18n.ts";

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
  const d = mkdtempSync(join(tmpdir(), "cp-i18n-"));
  tmpDirs.push(d);
  return d;
}

// ----- t() interpolation -----

test("t interpolates {placeholder} params", () => {
  const dict = { greet: "Hello {name}, you have {n} messages" };
  expect(t(dict, "greet", { name: "Ada", n: 3 })).toBe(
    "Hello Ada, you have 3 messages",
  );
});

test("t returns the raw key when the key is missing", () => {
  expect(t({}, "nope.missing")).toBe("nope.missing");
});

test("t leaves a {placeholder} verbatim when its param is not supplied", () => {
  const dict = { tpl: "a {known} b {unknown}" };
  expect(t(dict, "tpl", { known: "X" })).toBe("a X b {unknown}");
});

// ----- resolveLocale() -----

test("resolveLocale: explicit en/fr config wins", () => {
  expect(resolveLocale("fr", "en-US")).toBe("fr");
  expect(resolveLocale("en", "fr-FR")).toBe("en");
});

test("resolveLocale: empty (auto) derives from OS locale", () => {
  expect(resolveLocale("", "fr-CA")).toBe("fr");
  expect(resolveLocale("", "en-GB")).toBe("en");
  expect(resolveLocale("", "de-DE")).toBe("en"); // unsupported OS -> en
});

test("resolveLocale: unsupported config tag falls back to OS", () => {
  expect(resolveLocale("es", "fr-FR")).toBe("fr");
});

// ----- loadDict() layering & fallbacks -----

test("loadDict falls back to embedded EN when no files exist", () => {
  const dict = loadDict("fr", [freshDir()]);
  // No fr.json on disk -> the embedded English value stands in.
  expect(dict["common.save"]).toBe(EN_DEFAULTS["common.save"]);
});

test("loadDict: user-override dir wins over the shipped dir", () => {
  const shipped = freshDir();
  const user = freshDir();
  writeFileSync(join(shipped, "fr.json"), JSON.stringify({ "common.save": "Enregistrer" }));
  writeFileSync(join(user, "fr.json"), JSON.stringify({ "common.save": "OVERRIDE" }));
  const dict = loadDict("fr", [shipped, user]);
  expect(dict["common.save"]).toBe("OVERRIDE");
});

test("loadDict: a key present in en but absent in fr falls back to en", () => {
  const shipped = freshDir();
  // fr provides only one key; everything else must fall back to embedded en.
  writeFileSync(join(shipped, "fr.json"), JSON.stringify({ "common.save": "Enregistrer" }));
  const dict = loadDict("fr", [shipped]);
  expect(dict["common.save"]).toBe("Enregistrer");
  expect(dict["common.cancel"]).toBe(EN_DEFAULTS["common.cancel"]); // en fallback
});

test("loadDict: malformed JSON is ignored, embedded defaults survive", () => {
  const shipped = freshDir();
  writeFileSync(join(shipped, "fr.json"), "{ this is not json");
  const dict = loadDict("fr", [shipped]);
  expect(dict["common.save"]).toBe(EN_DEFAULTS["common.save"]);
});

// ----- parity guard: en.json must mirror EN_DEFAULTS -----

test("en.json key set is identical to EN_DEFAULTS", async () => {
  const enPath = join(import.meta.dir, "..", "desktop", "locales", "en.json");
  const enJson = (await Bun.file(enPath).json()) as Record<string, string>;
  expect(Object.keys(enJson).sort()).toEqual(Object.keys(EN_DEFAULTS).sort());
  // Values must match too -- en.json is the shipped copy of the embedded base.
  for (const k of Object.keys(EN_DEFAULTS)) {
    expect(enJson[k]).toBe(EN_DEFAULTS[k]);
  }
});

test("fr.json key set is identical to en.json (no missing/extra keys)", async () => {
  const dir = join(import.meta.dir, "..", "desktop", "locales");
  const en = (await Bun.file(join(dir, "en.json")).json()) as Record<string, string>;
  const fr = (await Bun.file(join(dir, "fr.json")).json()) as Record<string, string>;
  expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
});
