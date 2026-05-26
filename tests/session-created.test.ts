// tests/session-created.test.ts
//
// Handler orchestrates ensure-commands → bootstrap → reconcile.
// The bootstrap-first order is the RACE GUARD against pausing a
// session a concurrent hook just attached.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleSessionCreated } from "../src/handlers/session-created.ts";
import { DEFAULT_STATE, loadState, saveState, withLock, type PluginState } from "../src/state-store.ts";
import type { Deps } from "../src/deps.ts";
import type { McpClient } from "../src/mcp-client.ts";

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-sc-${name}-`));
}

interface CallLog {
  name: string;
  args: Record<string, unknown>;
}

function fakeClient(routes: Record<string, (args: Record<string, unknown>) => string>): McpClient & { calls: CallLog[] } {
  const calls: CallLog[] = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      const fn = routes[name];
      if (!fn) throw new Error(`unexpected tool call: ${name}`);
      return fn(args);
    },
  };
}

function makeDeps(dir: string, client: McpClient | null): Deps {
  return {
    dataDir: dir,
    worktree: "/p",
    loadState: () => loadState(dir),
    saveState: (s: PluginState) => saveState(dir, s),
    withLock: <T,>(fn: () => Promise<T>) => withLock(dir, fn),
    getClient: () => client,
    log: async () => undefined,
    now: () => 1000,
    env: { LIBRARIAN_MCP_URL: "http://x", LIBRARIAN_AGENT_TOKEN: "t" },
  };
}

const START_PROSE = "Session started.\nID: ses_new\nStatus: active\n";
const LIST_EMPTY = "No sessions found.\n";
const LIST_ONE_STALE = "Sessions:\n\n1. [active] stale — p — opencode — cwd:/p — t — n\n   id: ses_stale\n";
const LIST_BOTH = `Sessions:\n\n1. [active] ours — p — opencode — cwd:/p — t — n\n   id: ses_new\n2. [active] stale — p — opencode — cwd:/p — t — n\n   id: ses_stale\n`;
const PAUSE_PROSE = "Session paused.";

describe("handleSessionCreated", () => {
  test("happy path: bootstrap then no stale → just start_session + list_sessions", async () => {
    const dir = tmp("happy");
    const client = fakeClient({
      start_session: () => START_PROSE,
      list_sessions: () => LIST_EMPTY,
    });
    await handleSessionCreated({ cwd: "/p", runId: "oc1" }, makeDeps(dir, client));
    const seq = client.calls.map((c) => c.name);
    expect(seq).toEqual(["start_session", "list_sessions"]);
    expect((await loadState(dir)).session_id).toBe("ses_new");
  });

  test("bootstrap → reconcile pauses one stale session", async () => {
    const dir = tmp("one-stale");
    const client = fakeClient({
      start_session: () => START_PROSE,
      list_sessions: () => LIST_ONE_STALE,
      pause_session: () => PAUSE_PROSE,
    });
    await handleSessionCreated({ cwd: "/p", runId: "oc1" }, makeDeps(dir, client));
    const seq = client.calls.map((c) => c.name);
    expect(seq).toEqual(["start_session", "list_sessions", "pause_session"]);
    expect(client.calls[2]!.args.session_id).toBe("ses_stale");
  });

  test("RACE GUARD: list returns both ours and a stale — only stale gets paused", async () => {
    const dir = tmp("race-guard");
    const client = fakeClient({
      start_session: () => START_PROSE,
      list_sessions: () => LIST_BOTH,
      pause_session: () => PAUSE_PROSE,
    });
    await handleSessionCreated({ cwd: "/p", runId: "oc1" }, makeDeps(dir, client));
    const pauseCalls = client.calls.filter((c) => c.name === "pause_session");
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0]!.args.session_id).toBe("ses_stale");
    expect((await loadState(dir)).session_id).toBe("ses_new");
  });

  test("off-record: bootstrap + reconcile both skipped", async () => {
    const dir = tmp("private");
    await saveState(dir, { ...DEFAULT_STATE, private: true });
    const client = fakeClient({});
    await handleSessionCreated({ cwd: "/p", runId: "oc1" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(0);
  });

  test("list_sessions failure during reconcile is fail-soft — bootstrap result preserved", async () => {
    const dir = tmp("list-fails");
    const client = fakeClient({
      start_session: () => START_PROSE,
      list_sessions: () => { throw new Error("server down"); },
    });
    await handleSessionCreated({ cwd: "/p", runId: "oc1" }, makeDeps(dir, client));
    const seq = client.calls.map((c) => c.name);
    expect(seq).toEqual(["start_session", "list_sessions"]);
    expect((await loadState(dir)).session_id).toBe("ses_new");
  });

  test("pause_session failure on one session doesn't stop the others", async () => {
    const dir = tmp("pause-fails");
    let paused = 0;
    const list = `Sessions:\n\n1. [active] a — p — opencode — cwd:/p — t — n\n   id: ses_a\n2. [active] b — p — opencode — cwd:/p — t — n\n   id: ses_b\n`;
    const client = fakeClient({
      start_session: () => START_PROSE,
      list_sessions: () => list,
      pause_session: () => {
        paused++;
        if (paused === 1) throw new Error("flaky");
        return PAUSE_PROSE;
      },
    });
    await handleSessionCreated({ cwd: "/p", runId: "oc1" }, makeDeps(dir, client));
    const pauseCalls = client.calls.filter((c) => c.name === "pause_session");
    expect(pauseCalls.length).toBe(2);
  });
});
