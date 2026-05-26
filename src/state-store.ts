// src/state-store.ts
//
// Local plugin state — attached session_id, off-record flag, checkpoint
// debounce counters. Persisted to ${data dir}/state.json with an atomic
// write (write tmp → rename) so a crash mid-write can't leave the file
// half-rewritten, and so two concurrent hook invocations can serialise
// via withLock without corrupting each other.
//
// **Cross-process safety note** (see Plan Task 4): O_EXCL on the
// lockfile is POSIX-atomic on local filesystems. Verified empirically
// with two concurrent `bun` subprocesses contending for the same lock —
// exactly one acquires at a time. NOT safe across NFS/SMB mounts; this
// is fine in practice because opencode's data dir lives under
// `~/.local/share/opencode/` (Linux) or the equivalent on macOS, which
// are local.
//
// Schema is deliberately small + flat: nothing here is durable
// cross-machine — that's the Librarian server's job. This file just
// remembers what this opencode run has attached itself to.

import fs from "node:fs";
import path from "node:path";

const STATE_FILENAME = "state.json";
const LOCK_FILENAME = "state.json.lock";

export interface PluginState {
  /** `ses_…` of the currently-attached Librarian session, if any. */
  session_id: string | null;
  /** Off-record flag — chat.message handler flips this. */
  private: boolean;
  /** Epoch ms; used by the debounced-checkpoint policy. */
  last_checkpoint_at: number;
  /** Event count since the last checkpoint. */
  turns_since_checkpoint: number;
  /** Canonical source_ref the session was started against. */
  source_ref: string | null;
}

export const DEFAULT_STATE: Readonly<PluginState> = Object.freeze({
  session_id: null,
  private: false,
  last_checkpoint_at: 0,
  turns_since_checkpoint: 0,
  source_ref: null,
});

function statePath(dataDir: string): string {
  return path.join(dataDir, STATE_FILENAME);
}

function lockPath(dataDir: string): string {
  return path.join(dataDir, LOCK_FILENAME);
}

export async function loadState(dataDir: string): Promise<PluginState> {
  await fs.promises.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.promises.readFile(statePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<PluginState>;
    // Always normalise against DEFAULT_STATE so a partial file from an
    // older plugin version still gives every handler the fields it
    // expects.
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ...DEFAULT_STATE };
    // A malformed JSON file means somebody (or something) corrupted state
    // on disk. Loudly reset rather than crash every subsequent hook on
    // parse.
    if (err instanceof SyntaxError) return { ...DEFAULT_STATE };
    throw err;
  }
}

export async function saveState(dataDir: string, state: PluginState): Promise<void> {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const final = statePath(dataDir);
  // process.pid + a high-entropy random suffix make concurrent writers'
  // tmp names disjoint, so rename() can never accidentally clobber
  // another writer's not-yet-renamed file.
  const tmp = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.promises.rename(tmp, final); // POSIX-atomic on the same filesystem
}

export interface WithLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

/**
 * Serialise a load → mutate → save sequence across concurrent hook
 * invocations. The race we care about is multiple opencode hook events
 * firing close together (e.g. `chat.message` + `session.idle` on a
 * compaction boundary) and racing to update state.
 *
 * Implementation: O_EXCL on the lockfile. On EEXIST, spin briefly
 * (random backoff to avoid lock-step retries) up to `timeoutMs`, then
 * steal the lock only if it is older than `staleMs` (a previous hook
 * crashed after acquiring without releasing).
 *
 * **Invariant:** `staleMs` MUST be strictly greater than the longest
 * critical section any caller holds the lock across. The MCP client's
 * default timeout is 15 s (mcp-client.ts DEFAULT_TIMEOUT_MS), and the
 * session-bootstrap handler holds the lock across a `start_session`
 * call. So we default `staleMs` to 30 s — 2× the MCP timeout — so a
 * slow remote endpoint can't trigger lock theft mid-critical-section
 * (which would silently double-attach the session).
 */
export async function withLock<T>(
  dataDir: string,
  fn: () => Promise<T>,
  options: WithLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const staleMs = options.staleMs ?? 30000;
  await fs.promises.mkdir(dataDir, { recursive: true });
  const lock = lockPath(dataDir);
  const start = Date.now();
  let handle: fs.promises.FileHandle | null = null;

  while (handle === null) {
    try {
      handle = await fs.promises.open(lock, "wx");
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      // Try to steal a stale lock.
      try {
        const stat = await fs.promises.stat(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.promises.unlink(lock).catch(() => undefined);
          continue;
        }
      } catch {
        // The other side released between our open() and stat(). Loop.
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`state-store: could not acquire lock within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      /* already closed */
    }
    await fs.promises.unlink(lock).catch(() => undefined);
  }
}
