// src/log.ts
//
// Append-only structured log to ${dataDir}/log.jsonl. Hooks must never
// throw on a log failure — best-effort write, swallow errors. This is
// for post-hoc debugging from the user's machine, not telemetry.
//
// Rotation: at MAX_LOG_BYTES we rename the current file to
// log.jsonl.1 (overwriting any prior .1) and start fresh. One
// generation is plenty for a debug sidecar. Same shape as the Codex
// plugin's log.mjs.

import fs from "node:fs";
import path from "node:path";

const LOG_FILENAME = "log.jsonl";
const ROTATED_FILENAME = "log.jsonl.1";
export const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MiB

export async function log(dataDir: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.promises.mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, LOG_FILENAME);
    await rotateIfNeeded(dataDir, file);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.promises.appendFile(file, line, "utf8");
  } catch {
    // Best-effort. Never block a hook on log failure.
  }
}

async function rotateIfNeeded(dataDir: string, file: string): Promise<void> {
  let size: number;
  try {
    const stat = await fs.promises.stat(file);
    size = stat.size;
  } catch {
    return; // ENOENT or other stat error — no rotation needed; appendFile handles ENOENT.
  }
  if (size < MAX_LOG_BYTES) return;
  const rotated = path.join(dataDir, ROTATED_FILENAME);
  try {
    await fs.promises.rename(file, rotated);
  } catch {
    /* swallow — best-effort */
  }
}
