import { test, expect } from "bun:test";

// Pure module (no electron / node-pty), imports cleanly under bun.
import { moveBeside, reconcileOrder } from "../desktop/src/shared/reorder.ts";

// ----- moveBeside -----

test("moveBeside inserts before the target", () => {
  expect(moveBeside(["a", "b", "c", "d"], "d", "b", false)).toEqual(["a", "d", "b", "c"]);
});

test("moveBeside inserts after the target", () => {
  expect(moveBeside(["a", "b", "c", "d"], "a", "c", true)).toEqual(["b", "c", "a", "d"]);
});

test("moveBeside after the last target moves to the very end", () => {
  expect(moveBeside(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
});

test("moveBeside is a no-op (copy) when source === target", () => {
  const ids = ["a", "b", "c"];
  const out = moveBeside(ids, "b", "b", false);
  expect(out).toEqual(ids);
  expect(out).not.toBe(ids); // a fresh array
});

test("moveBeside is a no-op when an id is unknown", () => {
  expect(moveBeside(["a", "b"], "zzz", "a", false)).toEqual(["a", "b"]);
  expect(moveBeside(["a", "b"], "a", "zzz", false)).toEqual(["a", "b"]);
});

// ----- reconcileOrder -----

test("reconcileOrder reorders items to match the id order", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  expect(reconcileOrder(items, ["c", "a", "b"]).map((i) => i.id)).toEqual(["c", "a", "b"]);
});

test("reconcileOrder drops unknown ids and keeps missing items at the end", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  // 'zzz' is unknown (dropped); 'b' is missing from the list (kept at the end).
  expect(reconcileOrder(items, ["c", "zzz", "a"]).map((i) => i.id)).toEqual(["c", "a", "b"]);
});

test("reconcileOrder preserves original relative order of the missing tail", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  expect(reconcileOrder(items, ["d"]).map((i) => i.id)).toEqual(["d", "a", "b", "c"]);
});
