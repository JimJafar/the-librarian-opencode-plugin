// tests/session-compacted.test.ts

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSessionCompacted } from "../src/handlers/session-compacted.ts";
import { DEFAULT_STATE, loadState, saveState, withLock, type PluginState } from "../src/state-store.ts";
import type { Deps } from "../src/deps.ts";
import type { McpClient } from "../src/mcp-client.ts";

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-sco-${name}-`));
}

function fakeClient(stub: () => string): McpClient & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    callTool: async (name, args) => { calls.push({ name, args }); return stub(); },
  };
}

function makeDeps(dir: string, client: McpClient | null, now = 12345): Deps {
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

describe("handleSessionCompacted", () => {
  test("checkpoints when attached + resets debounce counters", async () => {
    const dir = tmp("happy");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", turns_since_checkpoint: 5, last_checkpoint_at: 100 });
    const client = fakeClient(() => "Session checkpointed.");
    await handleSessionCompacted({ sessionID: "oc1" }, makeDeps(dir, client, 99999));
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.name).toBe("checkpoint_session");
    expect(client.calls[0]!.args.session_id).toBe("ses_x");
    const state = await loadState(dir);
    expect(state.turns_since_checkpoint).toBe(0);
    expect(state.last_checkpoint_at).toBe(99999);
  });

  test("off-record: no-op", async () => {
    const dir = tmp("private");
    await saveState(dir, { ...DEFAULT_STATE, private: true, session_id: "ses_x" });
    const client = fakeClient(() => { throw new Error("nope"); });
    await handleSessionCompacted({ sessionID: "oc1" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(0);
  });

  test("no attached session: no-op", async () => {
    const dir = tmp("no-session");
    const client = fakeClient(() => { throw new Error("nope"); });
    await handleSessionCompacted({ sessionID: "oc1" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(0);
  });

  test("no client: no-op", async () => {
    const dir = tmp("no-client");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x" });
    await handleSessionCompacted({ sessionID: "oc1" }, makeDeps(dir, null));
    // No throw is the assertion.
    expect(true).toBe(true);
  });

  test("fail-soft on checkpoint error: counter NOT reset", async () => {
    const dir = tmp("fail");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x", turns_since_checkpoint: 7, last_checkpoint_at: 100 });
    const client = fakeClient(() => { throw new Error("server down"); });
    await handleSessionCompacted({ sessionID: "oc1" }, makeDeps(dir, client, 99999));
    const state = await loadState(dir);
    expect(state.last_checkpoint_at).toBe(100);
    expect(state.turns_since_checkpoint).toBe(7);
  });
});
