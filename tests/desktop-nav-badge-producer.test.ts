// Guards the single-producer rule of the nav badges: a bar must CALL the shared
// producer rather than re-sum its terms itself. Two producers are disciplined
// here, the Courrier attention count and the Git rail total.
// Scans source text rather than importing the modules, which pull in
// @shared/types, unresolvable outside desktop's own toolchain.
// Verifies no producer's own arithmetic, only that the bars call it; each
// banned-term list is hand-picked from today's internal terms and goes stale
// silently if that producer is rewritten.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const NAV_RAIL = join(REPO_ROOT, "desktop", "src", "renderer", "src", "components", "NavRail.tsx");
const MOBILE_NAV = join(REPO_ROOT, "desktop", "src", "renderer", "src", "components", "MobileNav.tsx");

function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface ProducerRule {
  /** Exported name of the single producer, as written at the call site. */
  producer: string;
  /** Specifier the producer must be imported from, verbatim. */
  from: string;
  requiredImport: RegExp;
  /** Call form, and what a bar re-implements when it is missing. */
  requiredCall: RegExp;
  callForm: string;
  callWhy: string;
  bannedTerms: string[];
  bannedWhy: string;
}

const BADGE_RULE: ProducerRule = {
  producer: "inboxBadgeCount",
  from: "../store",
  requiredImport: /import\s*\{[^}]*\binboxBadgeCount\b[^}]*\}\s*from\s*['"]\.\.\/store['"]/,
  requiredCall: /\buseDeck\(\s*inboxBadgeCount\s*\)/,
  callForm: "useDeck(inboxBadgeCount)",
  callWhy: "badge may be locally re-summed",
  bannedTerms: ["pendingApprovals.length", "graphDrafts.length", "inboxUnread", "inboxPendingCount("],
  bannedWhy: "badge terms belong only in store.ts's inboxBadgeCount",
};

// The Git rail total, second producer. Removing the sumDirty CALL while leaving
// its import is the whole defect: the module exists, nothing says the rail uses
// it, and the panel keeps rendering the terms of a total nobody computes any
// more. `.dirty` is banned outright because reading that field in the rail IS
// the re-summation -- the rail's only legitimate access to it goes through
// sumDirty.
const GIT_TOTAL_RULE: ProducerRule = {
  producer: "sumDirty",
  from: "@shared/worktree-count",
  requiredImport: /import\s*\{[^}]*\bsumDirty\b[^}]*\}\s*from\s*['"]@shared\/worktree-count['"]/,
  requiredCall: /\bsumDirty\(/,
  callForm: "sumDirty(...)",
  callWhy: "the rail total may be locally re-summed",
  bannedTerms: [".dirty"],
  bannedWhy: "the rail's terms belong only to sumDirty in @shared/worktree-count",
};

/** Pure audit: given file sources (name -> content), returns one violation string per problem found. */
function auditBadgeProducer(
  filesByName: Record<string, string>,
  rule: ProducerRule = BADGE_RULE
): string[] {
  const violations: string[] = [];
  for (const [name, rawSrc] of Object.entries(filesByName)) {
    const src = stripComments(rawSrc);
    if (!rule.requiredImport.test(src)) {
      violations.push(`${name}: does not import ${rule.producer} from '${rule.from}'`);
    }
    if (!rule.requiredCall.test(src)) {
      violations.push(`${name}: does not call ${rule.callForm} -- ${rule.callWhy}`);
    }
    for (const term of rule.bannedTerms) {
      if (src.includes(term)) {
        violations.push(`${name}: contains banned re-summation term "${term}" -- ${rule.bannedWhy}`);
      }
    }
  }
  return violations;
}

// ----- real-repo check -----------------------------------------------------

test("NavRail and MobileNav both call the single badge producer, with no local re-summation", () => {
  const files = {
    "NavRail.tsx": readFileSync(NAV_RAIL, "utf-8"),
    "MobileNav.tsx": readFileSync(MOBILE_NAV, "utf-8"),
  };
  expect(auditBadgeProducer(files)).toEqual([]);
});

// ----- fixture-backed positive/negative controls ----------------------------

function fixtureBar(badgeLine: string, importLine = "import { inboxBadgeCount, useDeck } from '../store'"): string {
  return `${importLine}\nexport function Bar() {\n  ${badgeLine}\n  return null\n}\n`;
}

test("fixture positive control: a bar that imports and calls the producer, no banned terms, is clean", () => {
  const files = { "Bar.tsx": fixtureBar("const badge = useDeck(inboxBadgeCount)") };
  expect(auditBadgeProducer(files)).toEqual([]);
});

test("fixture: ONE bar regressing to a local re-summed selector is caught, naming that bar specifically (asymmetric, the real bug shape)", () => {
  const files = {
    "NavRail.tsx": fixtureBar("const badge = useDeck(inboxBadgeCount)"),
    "MobileNav.tsx": fixtureBar(
      "const badge = useDeck((s) => s.pendingApprovals.length + s.graphDrafts.length)",
      "import { useDeck } from '../store'"
    ),
  };
  const violations = auditBadgeProducer(files);
  expect(violations.some((v) => v.startsWith("MobileNav.tsx:"))).toBe(true);
  expect(violations.some((v) => v.startsWith("NavRail.tsx:"))).toBe(false);
});

test("fixture: the call removed but the import left behind is still caught (a partial regression)", () => {
  const files = {
    "Bar.tsx": fixtureBar("const badge = useDeck((s) => s.inboxMessages.length)"),
  };
  const violations = auditBadgeProducer(files);
  expect(violations).toContain("Bar.tsx: does not call useDeck(inboxBadgeCount) -- badge may be locally re-summed");
});

test("fixture: the import removed but a stray call left behind is still caught", () => {
  const files = {
    "Bar.tsx": fixtureBar("const badge = useDeck(inboxBadgeCount)", "import { useDeck } from '../store'"),
  };
  const violations = auditBadgeProducer(files);
  expect(violations).toContain("Bar.tsx: does not import inboxBadgeCount from '../store'");
});

test("fixture: a banned re-summation term present ANYWHERE in the file is caught, even alongside a correct call", () => {
  const files = {
    "Bar.tsx": fixtureBar(
      "const badge = useDeck(inboxBadgeCount)\n  const debug = pendingApprovals.length"
    ),
  };
  const violations = auditBadgeProducer(files);
  expect(violations.some((v) => v.includes('banned re-summation term "pendingApprovals.length"'))).toBe(true);
});

test("fixture: a banned term mentioned only in a comment is NOT flagged", () => {
  const files = {
    "Bar.tsx": fixtureBar("const badge = useDeck(inboxBadgeCount) // do not use pendingApprovals.length here"),
  };
  expect(auditBadgeProducer(files)).toEqual([]);
});

// ----- second producer: the Git rail total ---------------------------------

test("the Git rail calls the single total producer, with no local re-summation", () => {
  const files = { "NavRail.tsx": readFileSync(NAV_RAIL, "utf-8") };
  expect(auditBadgeProducer(files, GIT_TOTAL_RULE)).toEqual([]);
});

function fixtureRail(
  totalLine: string,
  importLine = "import { sumDirty } from '@shared/worktree-count'"
): string {
  return `${importLine}\nexport function Rail() {\n  ${totalLine}\n  return null\n}\n`;
}

// Positive control: without it, a rule whose regexes match anything would keep
// the real-repo test above green while guarding nothing.
test("fixture positive control: a rail that imports and calls sumDirty is clean", () => {
  const files = { "Rail.tsx": fixtureRail("const total = sumDirty(rows)") };
  expect(auditBadgeProducer(files, GIT_TOTAL_RULE)).toEqual([]);
});

test("fixture: the sumDirty call dropped for an inlined sum, import left behind, is caught twice", () => {
  const files = { "Rail.tsx": fixtureRail("const total = rows.reduce((n, w) => n + w.dirty, 0)") };
  const violations = auditBadgeProducer(files, GIT_TOTAL_RULE);
  expect(violations).toContain(
    "Rail.tsx: does not call sumDirty(...) -- the rail total may be locally re-summed"
  );
  expect(violations).toContain(
    'Rail.tsx: contains banned re-summation term ".dirty" -- the rail\'s terms belong only to sumDirty in @shared/worktree-count'
  );
});

// The mode the round-2 arbitration left open: an inlined total that does not
// even read `dirty` (a wrong field, a length) trips no banned term, so only the
// required CALL stands between the rail and a silently false number.
test("fixture: an inlined total that reads no banned term at all is still caught by the required call", () => {
  const files = { "Rail.tsx": fixtureRail("const total = rows.length") };
  expect(auditBadgeProducer(files, GIT_TOTAL_RULE)).toEqual([
    "Rail.tsx: does not call sumDirty(...) -- the rail total may be locally re-summed",
  ]);
});
