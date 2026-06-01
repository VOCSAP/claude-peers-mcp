import { test, expect } from "bun:test";

// Pure module (no electron / node-pty / node builtins) -> imports cleanly under
// bun. Covers the rotating colour assignment + empty-palette fallback (D12).
import {
  DEFAULT_PALETTE,
  paletteColor,
} from "../desktop/src/shared/palette.ts";

test("paletteColor cycles through the palette", () => {
  const p = ["#111111", "#222222", "#333333"];
  expect(paletteColor(p, 0)).toBe("#111111");
  expect(paletteColor(p, 1)).toBe("#222222");
  expect(paletteColor(p, 2)).toBe("#333333");
  // wraps around past the end
  expect(paletteColor(p, 3)).toBe("#111111");
  expect(paletteColor(p, 4)).toBe("#222222");
});

test("paletteColor handles negative indices via double-modulo", () => {
  const p = ["#111111", "#222222", "#333333"];
  expect(paletteColor(p, -1)).toBe("#333333");
  expect(paletteColor(p, -3)).toBe("#111111");
});

test("paletteColor falls back to DEFAULT_PALETTE when the palette is empty", () => {
  expect(paletteColor([], 0)).toBe(DEFAULT_PALETTE[0]);
  expect(paletteColor([], DEFAULT_PALETTE.length)).toBe(DEFAULT_PALETTE[0]);
  // never returns undefined
  expect(paletteColor([], 999)).toBeTypeOf("string");
});

test("DEFAULT_PALETTE is non-empty hex colours", () => {
  expect(DEFAULT_PALETTE.length).toBeGreaterThan(0);
  for (const c of DEFAULT_PALETTE) {
    expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  }
});
