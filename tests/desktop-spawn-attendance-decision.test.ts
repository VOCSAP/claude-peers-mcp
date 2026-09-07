import { test, expect } from "bun:test";
// refusesUnattendedApproval is the decision index.ts's confirmSpawnShellFields,
// resolveTemplateInputs, confirmWorkspaceShellFields and
// confirmWorkspaceUntrustedCwd all call to decide whether to open a dialog
// (card ffafeea6) -- itself untestable directly under bun test since index.ts
// imports 'electron' and runs app.whenReady() at module scope, unlike this
// pure module (node builtins only).
import {
  refusesUnattendedApproval,
  type CallerAttendance,
} from "../desktop/src/main/workspace-service.ts";

// Every one of those four sinks checks supervisorSpawnMode === 'hands-free'
// BEFORE ever calling refusesUnattendedApproval, so this predicate never sees
// 'hands-free' at all -- it is the SAME code path for 'team-review' and
// 'full-control', which is exactly why forcing attendance to 'unattended'
// here closes both modes' dialog at once rather than needing a per-mode fix.

test("unattended, no pre-approval: refuses -- the dialog-opening branch is never reached", () => {
  expect(refusesUnattendedApproval("unattended", false)).toBe(true);
});

test("unattended, already pre-approved: does not refuse -- a cache hit still proceeds silently", () => {
  expect(refusesUnattendedApproval("unattended", true)).toBe(false);
});

test("attended, no pre-approval: does not refuse -- an attended caller may still be asked", () => {
  expect(refusesUnattendedApproval("attended", false)).toBe(false);
});

test("attended, already pre-approved: does not refuse", () => {
  expect(refusesUnattendedApproval("attended", true)).toBe(false);
});

// A caller with no pre-approval concept at all for its payload (no cache to
// consult, so it can only ever pass alreadyApproved=false) always refuses
// once unattended -- pinned here so a future call site that legitimately has
// nothing to fall back on cannot silently assume it is safe unattended.
test("an unattended caller with no pre-approval cache concept always refuses", () => {
  const attendance: CallerAttendance = "unattended";
  expect(refusesUnattendedApproval(attendance, false)).toBe(true);
});
