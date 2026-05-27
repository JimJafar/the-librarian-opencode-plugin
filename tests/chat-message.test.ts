// tests/chat-message.test.ts
//
// Off-record gate via opencode's chat.message hook (pre-LLM, mutable
// output → no one-turn lag).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleChatMessage } from "../src/handlers/chat-message.ts";
import { DEFAULT_STATE, loadState, saveState, withLock, type PluginState } from "../src/state-store.ts";
import type { Deps } from "../src/deps.ts";
import type { McpClient } from "../src/mcp-client.ts";

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `librarian-cm-${name}-`));
}

interface FakeClient extends McpClient {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

function fakeClient(stub: (req: { name: string; args: Record<string, unknown> }) => string): FakeClient {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return stub({ name, args });
    },
  };
}

function makeDeps(dir: string, client: McpClient | null = fakeClient(() => "Session started.\nID: ses_x\nStatus: active\n")): Deps {
  return {
    dataDir: dir,
    worktree: "/p",
    loadState: () => loadState(dir),
    saveState: (s: PluginState) => saveState(dir, s),
    withLock: <T,>(fn: () => Promise<T>) => withLock(dir, fn),
    getClient: () => client,
    getConvStateClient: () => ({ convStateGet: async () => null }),
    log: async () => undefined,
    now: () => 1000,
    env: { LIBRARIAN_MCP_URL: "http://x", LIBRARIAN_AGENT_TOKEN: "t" },
  };
}

describe("handleChatMessage — privacy gate", () => {
  test("non-marker prompt bootstraps when no session attached", async () => {
    const dir = tmp("non-marker");
    const client = fakeClient(() => "Session started.\nID: ses_x\nStatus: active\n");
    await handleChatMessage({ sessionID: "oc1", cwd: "/p", text: "what time is it" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.name).toBe("start_session");
    expect((await loadState(dir)).session_id).toBe("ses_x");
  });

  test("'off the record' ends attached session and flips state.private", async () => {
    const dir = tmp("enter-private");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_old" });
    const client = fakeClient(() => "Session ended.");
    await handleChatMessage({ sessionID: "oc1", cwd: "/p", text: "off the record" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.name).toBe("end_session");
    expect(client.calls[0]!.args.session_id).toBe("ses_old");
    const state = await loadState(dir);
    expect(state.private).toBe(true);
    expect(state.session_id).toBeNull();
  });

  test("entering private with no session attached: clean flip, no MCP call", async () => {
    const dir = tmp("enter-no-session");
    const client = fakeClient(() => { throw new Error("server should not be called"); });
    await handleChatMessage({ sessionID: "oc1", cwd: "/p", text: "keep this between us" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(0);
    expect((await loadState(dir)).private).toBe(true);
  });

  test("'back on the record' flips state.private back and does NOT record the exit turn", async () => {
    const dir = tmp("exit-private");
    await saveState(dir, { ...DEFAULT_STATE, private: true });
    const client = fakeClient(() => { throw new Error("server should not be called"); });
    await handleChatMessage({ sessionID: "oc1", cwd: "/p", text: "back on the record" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(0);
    expect((await loadState(dir)).private).toBe(false);
  });

  test("non-marker prompt while private: NO bootstrap, NO recording", async () => {
    const dir = tmp("non-marker-private");
    await saveState(dir, { ...DEFAULT_STATE, private: true });
    const client = fakeClient(() => { throw new Error("server should not be called"); });
    await handleChatMessage({ sessionID: "oc1", cwd: "/p", text: "what's next" }, makeDeps(dir, client));
    expect(client.calls.length).toBe(0);
    expect((await loadState(dir)).private).toBe(true);
  });

  test("/lib-toggle-private toggles correctly: public → private", async () => {
    const dir = tmp("toggle-1");
    const client = fakeClient(() => "Session ended.");
    await handleChatMessage({ sessionID: "oc1", cwd: "/p", text: "/lib-toggle-private" }, makeDeps(dir, client));
    expect((await loadState(dir)).private).toBe(true);
  });

  test("/lib-toggle-private toggles correctly: private → public", async () => {
    const dir = tmp("toggle-2");
    await saveState(dir, { ...DEFAULT_STATE, private: true });
    const client = fakeClient(() => { throw new Error("server should not be called"); });
    await handleChatMessage({ sessionID: "oc1", cwd: "/p", text: "/lib-toggle-private" }, makeDeps(dir, client));
    expect((await loadState(dir)).private).toBe(false);
    expect(client.calls.length).toBe(0);
  });

  test("end_session failure during enter-private is fail-soft — state still flips private", async () => {
    const dir = tmp("end-fails");
    await saveState(dir, { ...DEFAULT_STATE, session_id: "ses_x" });
    const client = fakeClient(() => { throw new Error("server down"); });
    await handleChatMessage({ sessionID: "oc1", cwd: "/p", text: "off the record" }, makeDeps(dir, client));
    expect((await loadState(dir)).private).toBe(true);
  });
});
