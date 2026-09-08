// The dictionary substitution transform.
//
// Deliberately trivial (TRANSFORM_PLAN.md): a word-boundary, case-preserving,
// single-pass find/replace over BLOCK.TEXT content in messages and in
// `system`. It exists to prove the transform seam is real, not to save tokens.
//
// Pure function of a canonical request. Knows nothing about providers,
// transport, or plugins.

import { BLOCK, ROLE } from '../canonical/index.js';

/**
 * Validate a dictionary against the two hazards named in TRANSFORM_PLAN.md:
 *
 *   - Key/value disjointness: a value must not contain any key as a match
 *     (the client replays the model's own words next turn, so a value that is
 *     also a key would re-substitute on turn two and the conversation drifts),
 *     and a key must not equal a value.
 *   - Determinism falls out of the dictionary being a plain object with no
 *     randomness; nothing here needs to enforce it beyond that.
 *
 * Throws with a message naming the offending pair; the caller (config
 * loading) turns that into a startup failure per the plan's "fail loudly
 * before any traffic" rule.
 */
export function validateDictionary(dict) {
  const entries = Object.entries(dict);
  const keys = entries.map(([k]) => k.toLowerCase());
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || key === '') {
      throw new Error(`transform dictionary: key ${JSON.stringify(key)} must be a non-empty string`);
    }
    if (typeof value !== 'string' || value === '') {
      throw new Error(`transform dictionary: value for key ${JSON.stringify(key)} must be a non-empty string`);
    }
    if (value.toLowerCase() === key.toLowerCase()) {
      throw new Error(`transform dictionary: key ${JSON.stringify(key)} maps to itself`);
    }
    for (const otherKey of keys) {
      if (value.toLowerCase().includes(otherKey)) {
        throw new Error(
          `transform dictionary: value ${JSON.stringify(value)} (for key ${JSON.stringify(key)}) contains ` +
            `dictionary key ${JSON.stringify(otherKey)} — this would re-substitute on the next turn, since the ` +
            'client replays the model\'s own reply as history',
        );
      }
    }
  }
  return dict;
}

/** Longest key first, so an overlap at the same position prefers the longer match. */
function compileEntries(dict) {
  return Object.entries(dict)
    .map(([key, value]) => ({ key, value, pattern: escapeRegExp(key) }))
    .sort((a, b) => b.key.length - a.key.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/**
 * Case-preserving replacement for the three patterns the plan states:
 * all-lowercase, all-uppercase, and capitalized-first-letter keys use the
 * matching casing on the value; anything else uses the value verbatim.
 */
function casedReplacement(matched, value) {
  if (matched === matched.toLowerCase()) return value.toLowerCase();
  if (matched === matched.toUpperCase()) return value.toUpperCase();
  if (matched[0] === matched[0].toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) {
    return value[0].toUpperCase() + value.slice(1).toLowerCase();
  }
  return value;
}

/**
 * Single left-to-right pass over `text`. Replaced spans are never rescanned —
 * built by walking the string once, matching the longest live key at each
 * position, and skipping past a match rather than rescanning inside it.
 *
 * @returns {{ text: string, edits: number }}
 */
export function substituteText(text, dict) {
  const entries = compileEntries(dict);
  if (entries.length === 0) return { text, edits: 0 };

  let out = '';
  let i = 0;
  let edits = 0;
  const lower = text.toLowerCase();

  outer: while (i < text.length) {
    if (!isWordChar(text[i - 1])) {
      for (const { key, value } of entries) {
        const end = i + key.length;
        if (lower.slice(i, end) !== key.toLowerCase()) continue;
        if (isWordChar(text[end])) continue; // not a full word
        const matched = text.slice(i, end);
        out += casedReplacement(matched, value);
        edits += 1;
        i = end;
        continue outer;
      }
    }
    out += text[i];
    i += 1;
  }

  return { text: out, edits };
}

function substituteBlock(block, dict) {
  if (block.type !== BLOCK.TEXT) return { block, edits: 0 };
  const { text, edits } = substituteText(block.text, dict);
  if (edits === 0) return { block, edits: 0 };
  return { block: { ...block, text }, edits };
}

function substituteBlocks(blocks, dict) {
  let edits = 0;
  const out = blocks.map((block) => {
    const result = substituteBlock(block, dict);
    edits += result.edits;
    return result.block;
  });
  return { blocks: edits === 0 ? blocks : out, edits };
}

function substituteMessage(message, dict) {
  // Only user/assistant turn text is in scope; a canonical SYSTEM-role message
  // is handled the same as any other message's content, same as `system`.
  if (message.role !== ROLE.USER && message.role !== ROLE.ASSISTANT && message.role !== ROLE.SYSTEM) {
    return { message, edits: 0 };
  }
  const { blocks, edits } = substituteBlocks(message.content, dict);
  if (edits === 0) return { message, edits: 0 };
  return { message: { ...message, content: blocks }, edits };
}

/**
 * @param {import('../canonical/index.js').request} req
 * @param {Record<string, string>} dict already-validated
 * @returns {{ request: object, edits: number }}
 */
export function substitute(req, dict) {
  if (Object.keys(dict).length === 0) return { request: req, edits: 0 };

  let edits = 0;

  let system = req.system;
  if (system !== null) {
    const result = substituteBlocks(system, dict);
    edits += result.edits;
    system = result.blocks;
  }

  const messages = req.messages.map((message) => {
    const result = substituteMessage(message, dict);
    edits += result.edits;
    return result.message;
  });

  if (edits === 0) return { request: req, edits: 0 };
  return { request: { ...req, system, messages }, edits };
}

export const name = 'substitute';

/** The transform interface `transforms/index.js` expects. */
export function createSubstituteTransform(dict) {
  validateDictionary(dict);
  return {
    name,
    apply: (req) => substitute(req, dict),
  };
}
