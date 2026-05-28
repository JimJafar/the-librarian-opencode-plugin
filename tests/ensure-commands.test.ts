// tests/ensure-commands.test.ts
//
// Install + sentinel idempotency + don't-clobber-user-edits.
//
// sessions-rethink PR 4 — the seven `lib-session-*` command files are
// retired and replaced by four new verbs (handoff, takeover, learn,
// toggle-private). The mechanism is unchanged; the fixture filenames
// are updated to match the real surface.

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
  fs.writeFileSync(path.join(dir, "handoff.md"), "handoff body");
  fs.writeFileSync(path.join(dir, "takeover.md"), "takeover body");
  fs.writeFileSync(path.join(dir, "README.txt"), "ignored — not .md");
  return dir;
}

function silentDeps(dataDir: string): Deps {
  return {
    dataDir,
    worktree: "/p",
    getConvStateClient: () => ({ convStateGet: async () => null }),
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
      pluginVersion: "0.2.0",
    });
    expect(r.written.sort()).toEqual(["handoff.md", "takeover.md"]);
    expect(r.skipped).toEqual([]);
    expect(r.sentinel).toBe("wrote");
    expect(fs.readFileSync(path.join(target, "handoff.md"), "utf8")).toBe("handoff body");
    expect(fs.readFileSync(path.join(target, ".librarian-installed"), "utf8")).toBe("0.2.0");
    // Non-markdown files in source are NOT copied.
    expect(fs.existsSync(path.join(target, "README.txt"))).toBe(false);
  });

  test("sentinel matches + all files present: short-circuits with no writes", async () => {
    const source = fixtureSource();
    const target = tmp("target-sentinel");
    fs.writeFileSync(path.join(target, "handoff.md"), "handoff body");
    fs.writeFileSync(path.join(target, "takeover.md"), "takeover body");
    fs.writeFileSync(path.join(target, ".librarian-installed"), "0.2.0");
    const r = await ensureCommands(silentDeps(target), {
      sourceDir: source,
      targetDir: target,
      pluginVersion: "0.2.0",
    });
    expect(r.sentinel).toBe("matched");
    expect(r.written).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  test("missing file gets rewritten, existing files left alone", async () => {
    const source = fixtureSource();
    const target = tmp("target-missing");
    fs.writeFileSync(path.join(target, "takeover.md"), "takeover body");
    fs.writeFileSync(path.join(target, ".librarian-installed"), "0.2.0");
    // Sentinel matches but handoff.md is missing.
    const r = await ensureCommands(silentDeps(target), {
      sourceDir: source,
      targetDir: target,
      pluginVersion: "0.2.0",
    });
    expect(r.written).toEqual(["handoff.md"]);
    expect(r.skipped).toEqual(["takeover.md"]);
    expect(r.sentinel).toBe("wrote");
    expect(fs.existsSync(path.join(target, "handoff.md"))).toBe(true);
  });

  test("user-edited file is NEVER clobbered, even on version bump", async () => {
    const source = fixtureSource();
    const target = tmp("target-edited");
    fs.writeFileSync(path.join(target, "handoff.md"), "USER CUSTOMISED BODY");
    fs.writeFileSync(path.join(target, "takeover.md"), "takeover body");
    fs.writeFileSync(path.join(target, ".librarian-installed"), "0.1.0"); // mismatched

    const r = await ensureCommands(silentDeps(target), {
      sourceDir: source,
      targetDir: target,
      pluginVersion: "0.2.0",
    });
    // Both files exist; neither gets written; sentinel updated to new version.
    expect(r.written).toEqual([]);
    expect(r.skipped.sort()).toEqual(["handoff.md", "takeover.md"]);
    expect(r.sentinel).toBe("wrote");
    expect(fs.readFileSync(path.join(target, "handoff.md"), "utf8")).toBe(
      "USER CUSTOMISED BODY",
    );
    expect(fs.readFileSync(path.join(target, ".librarian-installed"), "utf8")).toBe("0.2.0");
  });

  test("source dir unreadable: returns empty result, never throws", async () => {
    const target = tmp("target-no-source");
    const r = await ensureCommands(silentDeps(target), {
      sourceDir: "/does/not/exist",
      targetDir: target,
      pluginVersion: "0.2.0",
    });
    expect(r.written).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.sentinel).toBe("skipped");
  });
});
