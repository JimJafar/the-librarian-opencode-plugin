// tests/state-store.test.ts
//
// Atomicity, lock correctness (in-process AND cross-process), fail-safe
// behaviour. State on disk gates the lifecycle (attached session_id,
// off-record flag, checkpoint debounce counters); a half-written file
// or a lost update there would silently desync the plugin from the
// Librarian server. The cross-process test is the key one for Bun
// (Plan Task 4 risk-fast); it spawns two `bun` subprocesses contending
// for the same lock and asserts exactly one critical section ran at a
// time.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_STATE, loadState, saveState, withLock } from "../src/state-store.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contender = path.join(repoRoot, "scripts/lock-contender.ts");

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-opencode-${name}-`));
}

describe("loadState", () => {
  test("returns DEFAULT_STATE when no file exists", async () => {
    const dir = tmpDir("load-empty");
    const state = await loadState(dir);
    expect(state).toEqual(DEFAULT_STATE);
  });

  test("returns DEFAULT_STATE when the file is malformed JSON", async () => {
    const dir = tmpDir("load-malformed");
    fs.writeFileSync(path.join(dir, "state.json"), "{ not json", "utf8");
    const state = await loadState(dir);
    expect(state).toEqual(DEFAULT_STATE);
  });

  test("fills missing fields with DEFAULT_STATE values", async () => {
    const dir = tmpDir("load-partial");
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ session_id: "ses_abc" }), "utf8");
    const state = await loadState(dir);
    expect(state.session_id).toBe("ses_abc");
    expect(state.private).toBe(false);
    expect(state.last_checkpoint_at).toBe(0);
    expect(state.turns_since_checkpoint).toBe(0);
  });
});

describe("saveState", () => {
  test("writes atomically and leaves no .tmp residue", async () => {
    const dir = tmpDir("save-atomic");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_one" });
    const round = await loadState(dir);
    expect(round.session_id).toBe("ses_one");
    const residue = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(residue).toEqual([]);
  });

  test("concurrent saves don't corrupt the file", async () => {
    const dir = tmpDir("save-concurrent");
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(saveState(dir, { ...DEFAULT_STATE, session_id: `ses_${i}` }));
    }
    await Promise.all(writes);
    const final = await loadState(dir);
    expect(final.session_id).toMatch(/^ses_\d+$/);
  });
});

describe("withLock — in-process", () => {
  test("serialises mutators: only one critical section runs at a time", async () => {
    const dir = tmpDir("with-lock-inproc");
    let inside = 0;
    let maxConcurrent = 0;
    const work = async () => {
      inside++;
      maxConcurrent = Math.max(maxConcurrent, inside);
      await new Promise((r) => setTimeout(r, 25));
      inside--;
      return "done";
    };
    const tasks = [];
    for (let i = 0; i < 5; i++) tasks.push(withLock(dir, work));
    const results = await Promise.all(tasks);
    expect(maxConcurrent).toBe(1);
    expect(results).toEqual(["done", "done", "done", "done", "done"]);
  });

  test("releases the lock even when the body throws", async () => {
    const dir = tmpDir("with-lock-throw");
    await expect(withLock(dir, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const ok = await withLock(dir, async () => "released");
    expect(ok).toBe("released");
  });
});

describe("withLock — cross-process (Plan Task 4 risk-fast)", () => {
  test("two concurrent bun subprocesses don't overlap critical sections", async () => {
    const dir = tmpDir("with-lock-xproc");
    const holdMs = 80;
    const run = (): Promise<{ acquire: number; release: number }> =>
      new Promise((resolve, reject) => {
        const child = spawn("bun", [contender, dir, String(holdMs)], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`contender exited ${code}: ${stderr}`));
            return;
          }
          const acquire = Number(stdout.match(/acquire (\d+)/)?.[1]);
          const release = Number(stdout.match(/release (\d+)/)?.[1]);
          if (!Number.isFinite(acquire) || !Number.isFinite(release)) {
            reject(new Error(`could not parse contender output:\n${stdout}`));
            return;
          }
          resolve({ acquire, release });
        });
      });

    const [a, b] = await Promise.all([run(), run()]);

    // One contender finished before the other started. Whichever fired
    // first has its release < the other's acquire.
    const first = a.acquire < b.acquire ? a : b;
    const second = a.acquire < b.acquire ? b : a;
    expect(second.acquire).toBeGreaterThanOrEqual(first.release);
  }, 10_000);
});
