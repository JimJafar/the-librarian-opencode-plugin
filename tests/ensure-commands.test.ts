// tests/ensure-commands.test.ts
//
// Install + sentinel idempotency + don't-clobber-user-edits.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureCommands } from "../src/handlers/ensure-commands.ts";
import type { Deps } from "../src/deps.ts";

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-ec-${name}-`));
}

function fixtureSource(): string {
  const dir = tmp("source");
  fs.writeFileSync(path.join(dir, "lib-session-start.md"), "start body");
  fs.writeFileSync(path.join(dir, "lib-session-end.md"), "end body");
  fs.writeFileSync(path.join(dir, "README.txt"), "ignored — not .md");
  return dir;
}

function silentDeps(dataDir: string): Deps {
  return {
    dataDir,
    worktree: "/p",
    loadState: async () => ({ session_id: null, private: false, last_checkpoint_at: 0, turns_since_checkpoint: 0, source_ref: null }),
    saveState: async () => undefined,
    withLock: async (fn) => fn(),
    getClient: () => null,
    log: async () => undefined,
    now: () => 0,
    env: {},
  };
}

describe("ensureCommands", () => {
  test("fresh install: writes all .md files and creates the sentinel", async () => {
    const source = fixtureSource();
    const target = tmp("target-fresh");
    const r = await ensureCommands(silentDeps(target), {
      sourceDir: source,
      targetDir: target,
      pluginVersion: "0.1.0",
    });
    expect(r.written.sort()).toEqual(["lib-session-end.md", "lib-session-start.md"]);
    expect(r.skipped).toEqual([]);
    expect(r.sentinel).toBe("wrote");
    expect(fs.readFileSync(path.join(target, "lib-session-start.md"), "utf8")).toBe("start body");
    expect(fs.readFileSync(path.join(target, ".librarian-installed"), "utf8")).toBe("0.1.0");
    // Non-markdown files in source are NOT copied.
    expect(fs.existsSync(path.join(target, "README.txt"))).toBe(false);
  });

  test("sentinel matches + all files present: short-circuits with no writes", async () => {
    const source = fixtureSource();
    const target = tmp("target-sentinel");
    // Pre-populate as if a previous install ran.
    fs.writeFileSync(path.join(target, "lib-session-start.md"), "start body");
    fs.writeFileSync(path.join(target, "lib-session-end.md"), "end body");
    fs.writeFileSync(path.join(target, ".librarian-installed"), "0.1.0");
    const r = await ensureCommands(silentDeps(target), {
      sourceDir: source,
      targetDir: target,
      pluginVersion: "0.1.0",
    });
    expect(r.sentinel).toBe("matched");
    expect(r.written).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  test("missing file gets rewritten, existing files left alone", async () => {
    const source = fixtureSource();
    const target = tmp("target-missing");
    fs.writeFileSync(path.join(target, "lib-session-end.md"), "end body");
    fs.writeFileSync(path.join(target, ".librarian-installed"), "0.1.0");
    // Sentinel matches but lib-session-start.md is missing.
    const r = await ensureCommands(silentDeps(target), {
      sourceDir: source,
      targetDir: target,
      pluginVersion: "0.1.0",
    });
    expect(r.written).toEqual(["lib-session-start.md"]);
    expect(r.skipped).toEqual(["lib-session-end.md"]);
    expect(r.sentinel).toBe("wrote");
    expect(fs.existsSync(path.join(target, "lib-session-start.md"))).toBe(true);
  });

  test("user-edited file is NEVER clobbered, even on version bump", async () => {
    const source = fixtureSource();
    const target = tmp("target-edited");
    fs.writeFileSync(path.join(target, "lib-session-start.md"), "USER CUSTOMISED BODY");
    fs.writeFileSync(path.join(target, "lib-session-end.md"), "end body");
    fs.writeFileSync(path.join(target, ".librarian-installed"), "0.0.5"); // mismatched

    const r = await ensureCommands(silentDeps(target), {
      sourceDir: source,
      targetDir: target,
      pluginVersion: "0.1.0",
    });
    // Both files exist; neither gets written; sentinel updated to new version.
    expect(r.written).toEqual([]);
    expect(r.skipped.sort()).toEqual(["lib-session-end.md", "lib-session-start.md"]);
    expect(r.sentinel).toBe("wrote");
    expect(fs.readFileSync(path.join(target, "lib-session-start.md"), "utf8")).toBe("USER CUSTOMISED BODY");
    expect(fs.readFileSync(path.join(target, ".librarian-installed"), "utf8")).toBe("0.1.0");
  });

  test("source dir unreadable: returns empty result, never throws", async () => {
    const target = tmp("target-no-source");
    const r = await ensureCommands(silentDeps(target), {
      sourceDir: "/does/not/exist",
      targetDir: target,
      pluginVersion: "0.1.0",
    });
    expect(r.written).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.sentinel).toBe("skipped");
  });
});
