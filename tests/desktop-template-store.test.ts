import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node-only module (no electron / no @shared alias), imports under bun.
import {
  globalTemplatesDir,
  localTemplatesDir,
  listTemplates,
  writeTemplate,
  readTemplate,
} from "../desktop/src/main/template-store.ts";
import { toTemplate, TEMPLATE_TYPE } from "../desktop/src/shared/template.ts";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tpl-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function env(global: string): NodeJS.ProcessEnv {
  return { APPDATA: global, XDG_CONFIG_HOME: global } as NodeJS.ProcessEnv;
}

test("globalTemplatesDir / localTemplatesDir resolve under the app dirs", () => {
  const g = tmp();
  expect(globalTemplatesDir(env(g)).replace(/\\/g, "/")).toContain("claude-peers-desk/templates");
  const proj = tmp();
  expect(localTemplatesDir(proj).replace(/\\/g, "/")).toContain(".claude/claude-peers/templates");
});

test("write then read round-trips a template", () => {
  const g = tmp();
  const tpl = toTemplate([{ name: "dev", args: "--agent dev", color: "#abc" }], "My team");
  const path = writeTemplate(globalTemplatesDir(env(g)), "My team", tpl);
  const back = readTemplate(path);
  expect(back).not.toBeNull();
  expect(back!.type).toBe(TEMPLATE_TYPE);
  expect(back!.sessions[0].name).toBe("dev");
});

test("listTemplates reports global + local with source and session count, skipping junk", () => {
  const g = tmp();
  const proj = tmp();
  writeTemplate(globalTemplatesDir(env(g)), "team-a", toTemplate([{ name: "a" }, { name: "b" }], "Team A"));
  writeTemplate(localTemplatesDir(proj), "team-b", toTemplate([{ name: "c" }], "Team B"));
  // A malformed json in the global dir must be skipped, not crash the scan.
  writeFileSync(join(globalTemplatesDir(env(g)), "junk.json"), "{ not json", "utf-8");

  const list = listTemplates(proj, env(g));
  const byName = Object.fromEntries(list.map((t) => [t.name, t]));
  expect(byName["Team A"]).toMatchObject({ source: "global", sessionCount: 2 });
  expect(byName["Team B"]).toMatchObject({ source: "local", sessionCount: 1 });
  expect(list).toHaveLength(2); // junk.json skipped
});

test("listTemplates returns [] when the dirs do not exist", () => {
  expect(listTemplates(tmp(), env(tmp()))).toEqual([]);
});
