// Invariant 1 is structural, not conventional: plugins receive canonical objects
// they cannot write to. Every canonical factory freezes what it returns, so a
// plugin that tries to mutate throws in its own try/catch rather than quietly
// corrupting what a later observer sees.

/**
 * Freeze a value and everything reachable from it, in place.
 *
 * Freezing happens before recursion, so a cycle terminates on the
 * already-frozen check rather than overflowing the stack.
 *
 * @template T
 * @param {T} value
 * @returns {T} the same value, now frozen
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  // Buffers reach here as the raw bytes on an observation ctx. V8 refuses to
  // freeze an array buffer view that has elements, and they are opaque payloads
  // rather than model structure, so they are left alone.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }
  return value;
}
