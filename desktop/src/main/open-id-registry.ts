// Process-global registry of claude session ids currently open in this app.
// Belt-and-suspenders against resuming the same id from two workspaces (DESIGN
// 6.5) -- the file lock guards whole workspaces, this guards individual ids.
// Pure (no imports), unit-testable under bun.

export class OpenIdRegistry {
  private open = new Set<string>()

  /** Claim an id. Returns false if it is already open (caller must not resume it). */
  add(id: string): boolean {
    if (this.open.has(id)) return false
    this.open.add(id)
    return true
  }

  release(id: string): void {
    this.open.delete(id)
  }

  has(id: string): boolean {
    return this.open.has(id)
  }

  /** A read-only copy of the currently-open ids (for discovery filtering). */
  snapshot(): Set<string> {
    return new Set(this.open)
  }

  get size(): number {
    return this.open.size
  }
}
