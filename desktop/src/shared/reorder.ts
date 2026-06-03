// Pure ordering helpers shared by the renderer (drag-and-drop maths) and the
// main process (def-list reconciliation). No electron / node imports so both
// processes can import it and it is unit-testable under bun.

/**
 * Move `sourceId` to sit just before (or after, when `after` is true) `targetId`
 * within `ids`, returning a NEW array. No-op (a copy) when source === target or
 * either id is absent.
 */
export function moveBeside(
  ids: string[],
  sourceId: string,
  targetId: string,
  after: boolean
): string[] {
  if (sourceId === targetId) return ids.slice()
  if (!ids.includes(sourceId) || !ids.includes(targetId)) return ids.slice()
  const next = ids.filter((id) => id !== sourceId)
  let to = next.indexOf(targetId)
  if (after) to += 1
  next.splice(to, 0, sourceId)
  return next
}

/**
 * Reorder `items` to match `orderedIds`: ids present in both keep the order of
 * `orderedIds`; ids in `orderedIds` that are unknown are dropped; items missing
 * from `orderedIds` are appended in their original relative order (robust to a
 * stale caller that lists fewer ids than exist).
 */
export function reconcileOrder<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const byId = new Map(items.map((it) => [it.id, it]))
  const out: T[] = []
  for (const id of orderedIds) {
    const it = byId.get(id)
    if (it) {
      out.push(it)
      byId.delete(id)
    }
  }
  for (const it of items) if (byId.has(it.id)) out.push(it)
  return out
}
