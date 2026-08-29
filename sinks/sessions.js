// The sessions/ writer. One directory per session, one file per artifact.
//
// Writes for a session are serialized: a plugin rewrites the same file on every
// turn, and two concurrent turns must not interleave into half a transcript.
// Writes for different sessions do not wait on each other.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Session ids are hashes, but this is the one place a bad one would become a
// path, so it is checked rather than trusted.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * @param {{ dir: string }} options root directory for all sessions
 */
export function createSessionStore({ dir }) {
  const root = resolve(dir);
  /** @type {Map<string, Promise<unknown>>} one write chain per session */
  const chains = new Map();

  const enqueue = (sessionId, task) => {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    // The chain must survive a failed write, so it continues from a settled
    // promise rather than a rejected one.
    const next = previous.then(task, task);
    chains.set(
      sessionId,
      next.catch(() => {}),
    );
    return next;
  };

  return {
    root,

    /** Directory for a session, without creating it. */
    pathFor(sessionId, filename = '') {
      return join(root, sessionId, filename);
    },

    /**
     * Replace `sessions/<sessionId>/<filename>`. Written to a temporary name
     * and renamed, so a reader never catches a half-written transcript.
     */
    write(sessionId, filename, contents) {
      if (!SAFE_SEGMENT.test(sessionId)) {
        return Promise.reject(new Error(`unsafe session id ${JSON.stringify(sessionId)}`));
      }
      if (!SAFE_SEGMENT.test(filename)) {
        return Promise.reject(new Error(`unsafe filename ${JSON.stringify(filename)}`));
      }
      return enqueue(sessionId, async () => {
        const directory = join(root, sessionId);
        await mkdir(directory, { recursive: true });
        const target = join(directory, filename);
        const temporary = `${target}.tmp`;
        await writeFile(temporary, contents);
        await rename(temporary, target);
      });
    },

    /** Wait for every queued write. Used on shutdown. */
    async drain() {
      await Promise.allSettled([...chains.values()]);
    },
  };
}
