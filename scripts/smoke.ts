#!/usr/bin/env bun
// scripts/smoke.ts
//
// End-to-end smoke: a mock Librarian HTTP server + the real exported
// Plugin driven through synthetic opencode events. Asserts that the
// `experimental.chat.system.transform` hook makes exactly one
// `conv_state_get` call per turn and emits the canonical block when
// the row exists.
//
// sessions-rethink PR 4 — the session lifecycle hooks
// (`chat.message`, `session.created`, `session.idle`,
// `session.compacted`) are retired. The smoke only exercises the
// surviving surface: conv-state injection.
//
// What this DOESN'T cover: opencode itself loading the plugin (that's
// the manual install step logged in AUTONOMOUS-BUILD-NOTES).

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
let convStatePayload: string | null = null;
let convStateMiss = false;

function mockResponse(tool: string, args: Record<string, unknown>): string {
  allCalls.push({ tool, args });
  if (tool !== "conv_state_get") return `(mock has no response for ${tool})`;
  if (convStateMiss) {
    return "No conversation state for conv_id opencode:s_smoke.";
  }
  return (
    convStatePayload ?? "No conversation state for conv_id opencode:s_smoke."
  );
}

function startMock(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer ")) {
        res.statusCode = 401;
        res.end();
        return;
      }
      try {
        const rpc = JSON.parse(body) as {
          id: number;
          params: { name: string; arguments?: Record<string, unknown> };
        };
        const text = mockResponse(rpc.params.name, rpc.params.arguments ?? {});
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { content: [{ type: "text", text }] },
          }),
        );
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/mcp` });
    });
  });
}

function freshTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-opencode-smoke-"));
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    console.error("  calls so far:", JSON.stringify(allCalls.slice(-8), null, 2));
    process.exit(1);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function snapshotCalls(): number {
  return allCalls.length;
}

function callsSince(from: number): Call[] {
  return allCalls.slice(from);
}

interface PluginInputStub {
  worktree: string;
  directory: string;
}

(async () => {
  const { server, url } = await startMock();
  process.env.LIBRARIAN_MCP_URL = url;
  process.env.LIBRARIAN_AGENT_TOKEN = "smoke-token";

  // Quarantine the run: every plugin factory call invokes ensureCommands
  // which installs into ~/.config/opencode/commands by default. On macOS
  // `os.homedir()` ignores $HOME, so the safest sandbox is the explicit
  // LIBRARIAN_COMMANDS_DIR env var the resolver honours.
  const sandboxCommandsDir = path.join(freshTmp(), "commands");
  const prevCmdDir = process.env.LIBRARIAN_COMMANDS_DIR;
  process.env.LIBRARIAN_COMMANDS_DIR = sandboxCommandsDir;

  try {
    // Load the plugin's real entrypoint. We're running in Bun so the .ts
    // file resolves natively.
    const { default: plugin } = (await import(path.join(repoRoot, "src/index.ts"))) as {
      default: (input: PluginInputStub) => Promise<Record<string, unknown>>;
    };

    console.log("Scenario 1: experimental.chat.system.transform with a hit appends the block");
    {
      const dir = freshTmp();
      process.env.LIBRARIAN_PLUGIN_DATA = dir;
      convStatePayload = JSON.stringify({
        conv_id: "opencode:s_smoke",
        harness: "opencode",
        off_record: false,
      });
      convStateMiss = false;
      const from = snapshotCalls();
      const hooks = (await plugin({ worktree: "/proj", directory: "/proj" })) as {
        "experimental.chat.system.transform"?: (
          i: { sessionID: string },
          o: { system: string[] },
        ) => Promise<void>;
      };
      const handler = hooks["experimental.chat.system.transform"];
      assert(typeof handler === "function", "system.transform handler registered");
      const out = { system: ["BASE_SYSTEM"] };
      await handler({ sessionID: "s_smoke" }, out);
      const calls = callsSince(from);
      assert(calls.length === 1, "exactly one MCP call");
      assert(calls[0]!.tool === "conv_state_get", "called conv_state_get");
      const block = out.system[1] ?? "";
      assert(block.includes("<conversation-state>"), "block injected");
      assert(block.includes("conv_id: opencode:s_smoke"), "block carries conv_id");
      assert(block.includes("off_record: false"), "block carries off_record");
      assert(!block.includes("domain:"), "block carries no retired domain line");
    }

    console.log("\nScenario 2: experimental.chat.system.transform with a miss leaves system intact");
    {
      const dir = freshTmp();
      process.env.LIBRARIAN_PLUGIN_DATA = dir;
      convStateMiss = true;
      convStatePayload = null;
      const from = snapshotCalls();
      const hooks = (await plugin({ worktree: "/proj", directory: "/proj" })) as {
        "experimental.chat.system.transform"?: (
          i: { sessionID: string },
          o: { system: string[] },
        ) => Promise<void>;
      };
      const handler = hooks["experimental.chat.system.transform"]!;
      const out = { system: ["BASE_SYSTEM"] };
      await handler({ sessionID: "s_smoke" }, out);
      assert(out.system.length === 1 && out.system[0] === "BASE_SYSTEM", "no block injected");
      const calls = callsSince(from);
      assert(
        calls.length === 1 && calls[0]!.tool === "conv_state_get",
        "still queries conv_state_get once",
      );
    }

    console.log("\nScenario 3: plugin init installed the four command files");
    {
      const expected = ["handoff.md", "takeover.md", "learn.md", "toggle-private.md"];
      for (const file of expected) {
        assert(
          fs.existsSync(path.join(sandboxCommandsDir, file)),
          `installed commands/${file} to ${sandboxCommandsDir}`,
        );
      }
      assert(
        fs.existsSync(path.join(sandboxCommandsDir, ".librarian-installed")),
        "sentinel written",
      );
    }

    console.log("\nsmoke passed.");
  } finally {
    if (prevCmdDir === undefined) delete process.env.LIBRARIAN_COMMANDS_DIR;
    else process.env.LIBRARIAN_COMMANDS_DIR = prevCmdDir;
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
