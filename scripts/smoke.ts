#!/usr/bin/env bun
// scripts/smoke.ts
// End-to-end smoke: a mock Librarian HTTP server + the real exported
// Plugin driven through synthetic opencode events. Asserts the right
// MCP tool calls happen with the right args.
//
// What this DOESN'T cover: opencode itself loading the plugin (that's
// the manual install step logged in AUTONOMOUS-BUILD-NOTES). What it
// DOES cover: every lifecycle handler dispatched via the real
// src/index.ts entry point, against a real HTTP server, with state-
// store persisted to a temp dir.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

const allCalls: Call[] = [];
let staleActive: string[] = [];
let nextSessionId = 0;

function mockResponse(tool: string, args: Record<string, unknown>): string {
  allCalls.push({ tool, args });
  switch (tool) {
    case "start_session":
      nextSessionId += 1;
      return `Session started.\nID: ses_smoke${nextSessionId}\nStatus: active\n`;
    case "list_sessions": {
      if (staleActive.length === 0) return "No sessions found.\n";
      let body = "Sessions:\n\n";
      staleActive.forEach((id, i) => {
        body += `${i + 1}. [active] stale — proj — opencode — cwd:/p — t — n\n   id: ${id}\n`;
      });
      return body;
    }
    case "pause_session":
      return "Session paused.";
    case "end_session":
      return "Session ended.";
    case "checkpoint_session":
      return "Session checkpointed.";
    case "record_session_event":
      return "Event recorded.";
    default:
      return `(mock has no response for ${tool})`;
  }
}

function startMock(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const auth = req.headers.authorization ?? "";
      if (!String(auth).startsWith("Bearer ")) {
        res.statusCode = 401;
        res.end();
        return;
      }
      try {
        const rpc = JSON.parse(body) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
        const text = mockResponse(rpc.params.name, rpc.params.arguments ?? {});
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text }] } }));
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

function freshTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-opencode-smoke-"));
}

function readState(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

function snapshot(): number {
  return allCalls.length;
}

function callsSince(from: number): Call[] {
  return allCalls.slice(from);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    console.error("  recent calls:", JSON.stringify(allCalls.slice(-8), null, 2));
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// ─── runner ──────────────────────────────────────────────────────────
const { server, url } = await startMock();
process.env.LIBRARIAN_MCP_URL = url;
process.env.LIBRARIAN_AGENT_TOKEN = "smoke-token";
const commandsDir = freshTmp(); // not used for real commands install — keep ~/.config untouched
process.env.HOME = freshTmp(); // redirect default targetDir so ensure-commands writes to a temp HOME

console.log(`Mock Librarian on ${url}`);

const { default: plugin } = await import(path.join(repoRoot, "src/index.ts"));

async function makeHooks(dataDir: string, worktree = "/proj"): Promise<{ hooks: any }> {
  process.env.LIBRARIAN_PLUGIN_DATA = dataDir;
  const hooks = await plugin({ worktree, directory: worktree } as any);
  return { hooks };
}

try {
  // ───────────────────────────────────────────────────────────────────
  console.log("\nScenario 1: session.created bootstraps + ensure-commands runs");
  {
    const dataDir = freshTmp();
    const from = snapshot();
    const { hooks } = await makeHooks(dataDir);
    await hooks.event({
      event: { type: "session.created", properties: { info: { id: "oc-session-1" } } },
    });
    const calls = callsSince(from);
    const seq = calls.map((c) => c.tool);
    assert(seq.includes("start_session"), "start_session called on session.created");
    assert(seq.includes("list_sessions"), "list_sessions called (reconcile)");
    const state = readState(dataDir);
    assert(state?.session_id !== null && typeof state?.session_id === "string", "state.session_id set");
    assert((state?.session_id as string).startsWith("ses_smoke"), "session id is from the mock");
  }

  // ───────────────────────────────────────────────────────────────────
  console.log("\nScenario 2: chat.message non-marker bootstraps when no session attached");
  {
    const dataDir = freshTmp();
    const from = snapshot();
    const { hooks } = await makeHooks(dataDir);
    await hooks["chat.message"](
      { sessionID: "oc-1" },
      { message: {}, parts: [{ type: "text", text: "what's the time" }] },
    );
    const calls = callsSince(from);
    assert(calls.some((c) => c.tool === "start_session"), "chat.message bootstrapped");
  }

  // ───────────────────────────────────────────────────────────────────
  console.log("\nScenario 3: chat.message 'off the record' ends session + flips private");
  {
    const dataDir = freshTmp();
    // Pre-attach a session.
    fs.writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        session_id: "ses_pre",
        source_ref: "opencode:run:oc-1:cwd:/proj",
        private: false,
        last_checkpoint_at: 1000,
        turns_since_checkpoint: 0,
      }),
    );
    const from = snapshot();
    const { hooks } = await makeHooks(dataDir);
    await hooks["chat.message"](
      { sessionID: "oc-1" },
      { message: {}, parts: [{ type: "text", text: "off the record" }] },
    );
    const calls = callsSince(from);
    assert(calls.length === 1, "exactly one MCP call (end_session)");
    assert(calls[0]!.tool === "end_session", "tool is end_session");
    assert(calls[0]!.args.session_id === "ses_pre", "ended the pre-attached session");
    const state = readState(dataDir);
    assert(state?.private === true, "state.private flipped to true");
  }

  // ───────────────────────────────────────────────────────────────────
  console.log("\nScenario 4: session.idle records a per-turn message event");
  {
    const dataDir = freshTmp();
    fs.writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        session_id: "ses_active",
        source_ref: "opencode:run:oc-1:cwd:/proj",
        private: false,
        last_checkpoint_at: Date.now(),
        turns_since_checkpoint: 0,
      }),
    );
    const from = snapshot();
    const { hooks } = await makeHooks(dataDir);
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "oc-1" } } });
    const calls = callsSince(from);
    assert(calls.length === 1 && calls[0]!.tool === "record_session_event", "single record_session_event");
    assert(calls[0]!.args.type === "message", "event type=message");
  }

  // ───────────────────────────────────────────────────────────────────
  console.log("\nScenario 5: session.compacted triggers checkpoint");
  {
    const dataDir = freshTmp();
    fs.writeFileSync(
      path.join(dataDir, "state.json"),
      JSON.stringify({
        session_id: "ses_to_checkpoint",
        source_ref: "opencode:run:oc-1:cwd:/proj",
        private: false,
        last_checkpoint_at: 100,
        turns_since_checkpoint: 5,
      }),
    );
    const from = snapshot();
    const { hooks } = await makeHooks(dataDir);
    await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "oc-1" } } });
    const calls = callsSince(from);
    assert(calls.length === 1 && calls[0]!.tool === "checkpoint_session", "checkpoint_session called");
    const state = readState(dataDir);
    assert(state?.turns_since_checkpoint === 0, "debounce counter reset");
  }

  // ───────────────────────────────────────────────────────────────────
  console.log("\nScenario 6: session.created with stale active reconciles (pauses stale, keeps ours)");
  {
    const dataDir = freshTmp();
    staleActive = ["ses_stale_smoke"];
    const from = snapshot();
    const { hooks } = await makeHooks(dataDir);
    await hooks.event({
      event: { type: "session.created", properties: { info: { id: "oc-session-resume" } } },
    });
    const calls = callsSince(from);
    const pauseCalls = calls.filter((c) => c.tool === "pause_session");
    assert(pauseCalls.length === 1, "exactly one pause_session call");
    assert(pauseCalls[0]!.args.session_id === "ses_stale_smoke", "paused the stale id");
    staleActive = [];
  }

  console.log("\nAll scenarios passed.");
} catch (err) {
  console.error("smoke crashed:", err);
  process.exit(1);
} finally {
  server.close();
  // tidy
  void commandsDir;
}
