// tests/session-idle.test.ts

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSessionIdle } from "../src/handlers/session-idle.ts";
import { CHECKPOINT_MAX_TURNS, CHECKPOINT_MIN_INTERVAL_MS, shouldCheckpoint } from "../src/handlers/checkpoint-policy.ts";
import { DEFAULT_STATE, loadState, saveState, withLock, type PluginState } from "../src/state-store.ts";
import type { Deps } from "../src/deps.ts";
import type { McpClient } from "../src/mcp-client.ts";

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-si-${name}-`));
}

function fakeClient(routes: Record<string, () => string>): McpClient & { calls: Array<{ name: string }> } {
  const calls: Array<{ name: string }> = [];
  return {
    calls,
    callTool: async (name) => { calls.push({ name }); const fn = routes[name]; if (!fn) throw new Error(`no route: ${name}`); return fn(); },
  };
}

function makeDeps(dir: string, client: McpClient | null, now = 1_000_000): Deps {
  return {
    dataDir: dir, worktree: "/p",
    loadState: () => loadState(dir),
    saveState: (s: PluginState) => saveState(dir, s),
    withLock: <T,>(fn: () => Promise<T>) => withLock(dir, fn),
    getClient: () => client,
    log: async () => undefined,
    now: () => now,
    env: { LIBRARIAN_MCP_URL: "http://x", LIBRARIAN_AGENT_TOKEN: "t" },
  };
}

describe("checkpoint-policy.shouldCheckpoint", () => {
  test("false for null/undefined state", () => {
    expect(shouldCheckpoint(null, 0)).toBe(false);
    expect(shouldCheckpoint(undefined, 0)).toBe(false);
  });
  test("false when both elapsed and turns are below threshold", () => {
    expect(shouldCheckpoint({ ...DEFAULT_STATE, last_checkpoint_at: 1000, turns_since_checkpoint: 1 }, 2000)).toBe(false);
  });
  test("true at the interval threshold", () => {
    expect(shouldCheckpoint({ ...DEFAULT_STATE, last_checkpoint_at: 0 }, CHECKPOINT_MIN_INTERVAL_MS)).toBe(true);
  });
  test("true at the turns threshold", () => {
    expect(shouldCheckpoint({ ...DEFAULT_STATE, last_checkpoint_at: 1_000_000_000, turns_since_checkpoint: CHECKPOINT_MAX_TURNS }, 1_000_000_000)).toBe(true);
  });
});

describe("handleSessionIdle", () => {
  test("records a per-turn message event when attached, increments counter", async () => {
    const dir = tmp("record");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", last_checkpoint_at: 1_000_000 });
    const client = fakeClient({ record_session_event: () => "ok" });
    await handleSessionIdle({ sessionID: "oc1" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.name).toBe("record_session_event");
    const state = await loadState(dir);
    expect(state.turns_since_checkpoint).toBe(1);
  });

  test("turns-threshold triggers checkpoint and resets counter", async () => {
    const dir = tmp("turns");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", last_checkpoint_at: 1_000_000, turns_since_checkpoint: CHECKPOINT_MAX_TURNS - 1 });
    const client = fakeClient({ record_session_event: () => "ok", checkpoint_session: () => "ok" });
    await handleSessionIdle({ sessionID: "oc1" }, makeDeps(dir, client));
    expect(client.calls.filter((c) => c.name === "checkpoint_session").length).toBe(1);
    expect((await loadState(dir)).turns_since_checkpoint).toBe(0);
  });

  test("interval-threshold triggers checkpoint", async () => {
    const dir = tmp("interval");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", last_checkpoint_at: 0, turns_since_checkpoint: 1 });
    const client = fakeClient({ record_session_event: () => "ok", checkpoint_session: () => "ok" });
    await handleSessionIdle({ sessionID: "oc1" }, makeDeps(dir, client, CHECKPOINT_MIN_INTERVAL_MS + 1));
    expect(client.calls.filter((c) => c.name === "checkpoint_session").length).toBe(1);
  });

  test("off-record: no-op", async () => {
    const dir = tmp("private");
    await saveState(dir, { ...DEFAULT_STATE, private: true, session_id: "ses_x" });
    const client = fakeClient({ record_session_event: () => { throw new Error("nope"); } });
    await handleSessionIdle({ sessionID: "oc1" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(0);
  });

  test("no session: no-op", async () => {
    const dir = tmp("no-session");
    const client = fakeClient({ record_session_event: () => { throw new Error("nope"); } });
    await handleSessionIdle({ sessionID: "oc1" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(0);
  });

  test("record failure: no checkpoint attempt", async () => {
    const dir = tmp("record-fails");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", turns_since_checkpoint: CHECKPOINT_MAX_TURNS - 1 });
    const client = fakeClient({ record_session_event: () => { throw new Error("nope"); } });
    await handleSessionIdle({ sessionID: "oc1" }, makeDeps(dir, client));
    expect(client.calls.filter((c) => c.name === "checkpoint_session").length).toBe(0);
  });

  test("checkpoint failure: counter preserved for retry", async () => {
    const dir = tmp("ck-fails");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", last_checkpoint_at: 0, turns_since_checkpoint: CHECKPOINT_MAX_TURNS - 1 });
    const client = fakeClient({
      record_session_event: () => "ok",
      checkpoint_session: () => { throw new Error("nope"); },
    });
    await handleSessionIdle({ sessionID: "oc1" }, makeDeps(dir, client));
    const state = await loadState(dir);
    expect(state.turns_since_checkpoint).toBe(CHECKPOINT_MAX_TURNS);
  });
});
