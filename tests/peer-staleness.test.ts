import { test, expect } from "bun:test";
import { mirrorStaleSec, mirrorStaleWarning, DEFAULT_ACTIVE_STALE_SEC } from "../shared/peer-staleness.ts";

const BACKOFF_60S_MS = 60_000;

test("mirrorStaleSec leaves a cutoff already at or above the floor untouched", () => {
  expect(mirrorStaleSec(150, BACKOFF_60S_MS)).toBe(150);
});

test("mirrorStaleSec at exactly the floor (2x a 60s backoff = 120s) is a no-op", () => {
  expect(mirrorStaleSec(120, BACKOFF_60S_MS)).toBe(120);
});

test("mirrorStaleSec one second under the floor is raised to it", () => {
  expect(mirrorStaleSec(119, BACKOFF_60S_MS)).toBe(120);
});

test("mirrorStaleSec rejects NaN by falling back to the default, never to 0", () => {
  expect(mirrorStaleSec(NaN, BACKOFF_60S_MS)).toBe(Math.max(DEFAULT_ACTIVE_STALE_SEC, 120));
});

test("mirrorStaleSec rejects 0 by falling back to the default, never to 0", () => {
  expect(mirrorStaleSec(0, BACKOFF_60S_MS)).toBe(Math.max(DEFAULT_ACTIVE_STALE_SEC, 120));
});

test("mirrorStaleSec rejects a negative value by falling back to the default", () => {
  expect(mirrorStaleSec(-5, BACKOFF_60S_MS)).toBe(Math.max(DEFAULT_ACTIVE_STALE_SEC, 120));
});

test("mirrorStaleSec rejects Infinity (non-finite) by falling back to the default", () => {
  expect(mirrorStaleSec(Infinity, BACKOFF_60S_MS)).toBe(Math.max(DEFAULT_ACTIVE_STALE_SEC, 120));
});

test("mirrorStaleSec also floors a bad backoff input rather than propagating it", () => {
  // An invalid backoff falls back to the module's own default (60_000ms), so
  // the floor is still 2x that default, never NaN/Infinity/0.
  expect(mirrorStaleSec(30, NaN)).toBe(120);
  expect(mirrorStaleSec(30, -1)).toBe(120);
  expect(mirrorStaleSec(30, Infinity)).toBe(120);
});

test("mirrorStaleSec fallback is measured with a low backoff, where the floor cannot mask it", () => {
  // With a 1 s backoff the floor is 2 s: a fallback to 0 would show as 2, the default shows as 120.
  for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    expect(mirrorStaleSec(bad, 1_000), `invalid ${bad} must fall back to the ${DEFAULT_ACTIVE_STALE_SEC}s default, not to 0`).toBe(
      DEFAULT_ACTIVE_STALE_SEC
    );
  }
  expect(mirrorStaleSec(1, 1_000), "a valid value under twice a low backoff is floored to twice that backoff").toBe(2);
});

test("mirrorStaleSec also honours the online sync tick, which has no ceiling", () => {
  expect(mirrorStaleSec(120, BACKOFF_60S_MS, 300_000), "a 5 min tick means passes 5 min apart: the floor follows it").toBe(600);
  expect(mirrorStaleSec(120, BACKOFF_60S_MS, 5_000), "a 5 s tick is below the backoff ceiling and changes nothing").toBe(120);
  expect(mirrorStaleSec(120, BACKOFF_60S_MS, Number.NaN), "an unusable tick is ignored, never propagated").toBe(120);
});

test("mirrorStaleWarning is silent outside replica mode no matter how low the cutoff", () => {
  expect(mirrorStaleWarning(5, BACKOFF_60S_MS, false)).toBeNull();
});

test("mirrorStaleWarning is silent in replica mode once the cutoff reaches the floor (nothing is raised)", () => {
  expect(mirrorStaleWarning(120, BACKOFF_60S_MS, true), "exactly the floor: the setting is in force as written").toBeNull();
  expect(mirrorStaleWarning(300, BACKOFF_60S_MS, true)).toBeNull();
});

test("mirrorStaleWarning fires in replica mode whenever the floor raises the setting, not only under the backoff", () => {
  for (const raised of [59, 60, 119]) {
    const warning = mirrorStaleWarning(raised, BACKOFF_60S_MS, true);
    expect(warning, `a value of ${raised}s is silently raised to 120s for mirrors: the operator must be told`).not.toBeNull();
    expect(warning).toContain(`${raised}`);
    expect(warning).toContain("120");
  }
});

test("mirrorStaleWarning names the applied floor in its text", () => {
  const warning = mirrorStaleWarning(10, BACKOFF_60S_MS, true);
  expect(warning).toContain("120");
});

for (const bad of [NaN, 0, -5, Infinity]) {
  test(`mirrorStaleWarning fires in replica mode for an invalid value (${bad}) and says it fell back`, () => {
    const warning = mirrorStaleWarning(bad, BACKOFF_60S_MS, true);
    expect(warning).not.toBeNull();
    expect(warning).toContain(String(DEFAULT_ACTIVE_STALE_SEC));
  });

  test(`mirrorStaleWarning is silent outside replica mode for an invalid value (${bad})`, () => {
    expect(mirrorStaleWarning(bad, BACKOFF_60S_MS, false)).toBeNull();
  });
}
