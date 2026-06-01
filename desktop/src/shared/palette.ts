// Session colour palette, shared across main (auto-assignment) and renderer
// (the Settings editor). Pure (no electron / node-pty / node builtins) so it is
// unit-testable under bun and safe to import from either process. Exposed as a
// configurable AppConfig.palette (D12) with these values as the default.

/** Default rotating palette for auto-assigned session colours. */
export const DEFAULT_PALETTE: string[] = [
  '#4f86ff',
  '#3ec46d',
  '#e0b341',
  '#e0655b',
  '#a06bff',
  '#26b8c4',
  '#e08a3c',
  '#d45ec4',
  '#6aa84f',
  '#5b8def'
]

/**
 * Colour for the nth session, cycling through `palette`. Falls back to
 * DEFAULT_PALETTE when `palette` is empty (a user who cleared every entry still
 * gets distinct colours). Negative indices are handled by the double-modulo.
 */
export function paletteColor(palette: string[], index: number): string {
  const p = palette.length > 0 ? palette : DEFAULT_PALETTE
  return p[((index % p.length) + p.length) % p.length] as string
}
