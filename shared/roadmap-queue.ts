/**
 * A queued rank is a positive integer; null means unqueued. `Number.isInteger`
 * rejects `NaN`, `Infinity` and floats -- a `< 1` check alone would let those
 * through silently since every comparison against `NaN` is false.
 */
export function isValidQueueRank(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
