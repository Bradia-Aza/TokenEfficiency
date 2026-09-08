// Ordered transform application, edit counting, error isolation.
//
// This is the transform-side mirror of `pipeline/index.js`, and deliberately a
// separate mechanism (TRANSFORM_PLAN.md invariant 1): a transform is not a
// plugin, has its own list, its own registry, and lives in its own directory.
// If a transform ever gets registered as a plugin, this distinction has
// collapsed.
//
// `apply` is a pure function: canonical request in, `{ request, edits,
// byTransform }` out. Each transform in the list is individually try/caught —
// a throwing transform is skipped and logged, the others still run — mirroring
// invariant 3's fallback rule at the transform-list level. The final request is
// re-frozen, since every canonical factory freezes its own output but the
// transforms rebuild plain objects along the way.

import { deepFreeze } from '../canonical/freeze.js';

/**
 * @param {import('../canonical/index.js').request} canonicalRequest
 * @param {Array<{ name: string, apply: (req: object) => { request: object, edits: number } }>} transforms
 * @param {{ log?: Console }} [opts]
 * @returns {{ request: object, edits: number, byTransform: Record<string, number> }}
 */
export function apply(canonicalRequest, transforms, { log = console } = {}) {
  let current = canonicalRequest;
  let edits = 0;
  const byTransform = {};

  for (const transform of transforms) {
    byTransform[transform.name] = 0;
    try {
      const result = transform.apply(current);
      if (!result || typeof result !== 'object' || typeof result.edits !== 'number') {
        throw new TypeError(`transform ${transform.name}: apply() must return { request, edits }`);
      }
      byTransform[transform.name] = result.edits;
      edits += result.edits;
      current = result.request;
    } catch (err) {
      log.error(`[gateway] transform ${transform.name} failed and was skipped: ${err?.stack || err}`);
    }
  }

  return { request: edits === 0 ? canonicalRequest : deepFreeze(current), edits, byTransform };
}

/**
 * Compare two canonical requests block by block and count how many `BLOCK.TEXT`
 * blocks (in `system` and in messages) differ.
 *
 * This is Phase 6.4's after-the-fact observation half of `apply`'s edit count:
 * transport's seam only ever hands bytes across (TRANSFORM_PLAN.md's "transport
 * learns nothing about canonical objects"), so the edit count `apply` computed
 * live does not reach the exchange record. Rather than widen that seam,
 * `pipeline/exchange.js` re-derives the same fact once both the pre- and
 * post-transform bytes have already been turned back into canonical objects
 * for observation anyway. It is a count of *changed blocks*, not a substitute
 * for `apply`'s per-transform breakdown — there is exactly one transform in
 * this phase, so "how many blocks changed" and "how many edits `substitute`
 * made" coincide; a second transform would need this diff to become
 * transform-aware to keep saying which one touched what.
 *
 * @param {object} before canonical request before the transform ran
 * @param {object} after canonical request after
 * @returns {number} count of BLOCK.TEXT blocks whose text differs
 */
export function countTextEdits(before, after) {
  let edits = 0;
  const diffBlocks = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i]?.type === 'text' && b[i]?.type === 'text' && a[i].text !== b[i].text) edits += 1;
    }
  };
  diffBlocks(before.system ?? [], after.system ?? []);
  for (let i = 0; i < Math.max(before.messages.length, after.messages.length); i += 1) {
    diffBlocks(before.messages[i]?.content ?? [], after.messages[i]?.content ?? []);
  }
  return edits;
}

export function validate(transforms) {
  if (!Array.isArray(transforms)) throw new TypeError('transforms: transform list must be an array');
  return transforms.map((transform, index) => {
    if (transform === null || typeof transform !== 'object') {
      throw new TypeError(`transforms: transform at index ${index} is not an object`);
    }
    if (typeof transform.name !== 'string' || transform.name === '') {
      throw new TypeError(`transforms: transform at index ${index} has no name`);
    }
    if (typeof transform.apply !== 'function') {
      throw new TypeError(`transforms: ${transform.name}.apply is not a function`);
    }
    return transform;
  });
}
