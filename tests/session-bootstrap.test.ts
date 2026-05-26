// tests/session-bootstrap.test.ts
//
// Race + fail-soft + privacy. The race covers concurrent hook fires
// from opencode (e.g. session.created + chat.message both calling
// bootstrap on the first interaction).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapSession } from "../src/handlers/session-bootstrap.ts";
import { DEFAULT_STATE, loadState, saveState, withLock, type PluginState } from "../src/state-store.ts";
import type { Deps } from "../src/deps.ts";
import type { McpClient } from "../src/mcp-client.ts";

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-opencode-bs-${name}-`));
}

interface FakeClient extends McpClient {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

function fakeClient(stub: (req: { name: string; args: Record<string, unknown>; callCount: number }) => string): FakeClient {
  const calls: FakeClient["calls"] = [];
  const client: FakeClient = {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return stub({ name, args, callCount: calls.length });
    },
  };
  return client;
}

function makeDeps(dir: string, opts: { client?: McpClient | null; env?: NodeJS.ProcessEnv; now?: () => number } = {}): Deps {
  const env = opts.env ?? { LIBRARIAN_MCP_URL: "http://x", LIBRARIAN_AGENT_TOKEN: "t" };
  const client = opts.client === undefined ? fakeClient(() => "Session started.\nID: ses_x\nStatus: active\n") : opts.client;
  return {
    dataDir: dir,
    worktree: "/p",
    loadState: () => loadState(dir),
    saveState: (s: PluginState) => saveState(dir, s),
    withLock: <T,>(fn: () => Promise<T>) => withLock(dir, fn),
    getClient: () => client,
    log: async () => undefined,
    now: opts.now ?? (() => 1000),
    env,
  };
}

describe("bootstrapSession", () => {
  test("starts a session when none is attached", async () => {
    const dir = tmp("first-start");
    const client = fakeClient(() => "Session started.\nID: ses_new1\nStatus: active\n");
    const deps = makeDeps(dir, { client });
    const state = await bootstrapSession({ cwd: "/p", runId: "oc1" }, deps);
    expect(state.session_id).toBe("ses_new1");
    expect(state.source_ref).toBe("opencode:run:oc1:cwd:/p");
    expect((client as FakeClient).calls.length).toBe(1);
    expect((client as FakeClient).calls[0]!.name).toBe("start_session");
    const args = (client as FakeClient).calls[0]!.args;
    expect(args.harness).toBe("opencode");
    expect(args.visibility).toBe("common");
    expect(args.capture_mode).toBe("summary");
  });

  test("is a no-op when a session is already attached", async () => {
    const dir = tmp("already");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_existing" });
    const client = fakeClient(() => { throw new Error("server should not be called"); });
    const deps = makeDeps(dir, { client });
    const state = await bootstrapSession({ cwd: "/p", runId: "oc1" }, deps);
    expect(state.session_id).toBe("ses_existing");
    expect((client as FakeClient).calls.length).toBe(0);
  });

  test("is a no-op while off-record", async () => {
    const dir = tmp("private");
    await saveState(dir, { ...DEFAULT_STATE, private: true });
    const client = fakeClient(() => { throw new Error("server should not be called"); });
    const deps = makeDeps(dir, { client });
    const state = await bootstrapSession({ cwd: "/p", runId: "oc1" }, deps);
    expect(state.session_id).toBeNull();
    expect(state.private).toBe(true);
    expect((client as FakeClient).calls.length).toBe(0);
  });

  test("RACE: 5 concurrent bootstraps produce one start_session call", async () => {
    const dir = tmp("race");
    let n = 0;
    const client = fakeClient(() => `Session started.\nID: ses_${++n}\nStatus: active\n`);
    const deps = makeDeps(dir, { client });
    const tasks = [];
    for (let i = 0; i < 5; i++) tasks.push(bootstrapSession({ cwd: "/p", runId: "oc1" }, deps));
    await Promise.all(tasks);
    expect((client as FakeClient).calls.length).toBe(1);
    const final = await loadState(dir);
    expect(final.session_id).toBe("ses_1");
  });

  test("fails soft when the server errors — no session attached, no throw", async () => {
    const dir = tmp("fail-soft");
    const client = fakeClient(() => { throw new Error("boom"); });
    const deps = makeDeps(dir, { client });
    const state = await bootstrapSession({ cwd: "/p", runId: "oc1" }, deps);
    expect(state.session_id).toBeNull();
  });

  test("fails soft when no MCP client is available", async () => {
    const dir = tmp("no-client");
    const deps = makeDeps(dir, { client: null });
    const state = await bootstrapSession({ cwd: "/p", runId: "oc1" }, deps);
    expect(state.session_id).toBeNull();
  });

  test("fails soft when the server response has no session id", async () => {
    const dir = tmp("no-id");
    const client = fakeClient(() => "Some prose that does not include an ID line.");
    const deps = makeDeps(dir, { client });
    const state = await bootstrapSession({ cwd: "/p", runId: "oc1" }, deps);
    expect(state.session_id).toBeNull();
  });

  test("start_summary seed includes the opening prompt when supplied", async () => {
    const dir = tmp("with-prompt");
    const client = fakeClient(() => "Session started.\nID: ses_x\nStatus: active\n");
    const deps = makeDeps(dir, { client });
    await bootstrapSession({ cwd: "/p", runId: "oc1", seedPrompt: "fix the failing test" }, deps);
    const summary = String((client as FakeClient).calls[0]!.args.start_summary);
    expect(summary).toContain("Working in /p.");
    expect(summary).toContain("Opening prompt: fix the failing test");
  });
});
