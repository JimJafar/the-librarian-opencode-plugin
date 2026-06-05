// tests/conv-state-client.test.ts
//
// convStateGet wraps the existing MCP client with fail-soft null
// coercion. These cases pin the parsing + error-collapse contract.

import { describe, expect, test } from "bun:test";
import { createConvStateClient } from "../src/conv-state-client.ts";
import { McpClientError, type McpClient } from "../src/mcp-client.ts";

function fakeMcp(impl: (name: string, args: Record<string, unknown>) => Promise<string>): McpClient {
  return { callTool: impl };
}

describe("convStateGet", () => {
  test("returns the parsed row on a JSON hit", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async (name, args) => {
        expect(name).toBe("conv_state_get");
        expect(args).toEqual({ conv_id: "opencode:s_1" });
        return JSON.stringify({
          conv_id: "opencode:s_1",
          off_record: false,
        });
      }),
    );
    const state = await client.convStateGet("opencode:s_1", 500);
    expect(state).toEqual({
      conv_id: "opencode:s_1",
      off_record: false,
    });
  });

  test("returns null on the not-found prose response", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async () => "No conversation state for conv_id opencode:s_1"),
    );
    expect(await client.convStateGet("opencode:s_1", 500)).toBeNull();
  });

  test("returns null on non-JSON", async () => {
    const client = createConvStateClient(() => fakeMcp(async () => "not json {"));
    expect(await client.convStateGet("opencode:s_1", 500)).toBeNull();
  });

  test("returns null on JSON without conv_id", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async () => JSON.stringify({ domain: "work" })),
    );
    expect(await client.convStateGet("opencode:s_1", 500)).toBeNull();
  });

  test("returns null on the McpClientError taxonomy", async () => {
    for (const kind of ["network", "http", "timeout", "rpc", "malformed", "config"] as const) {
      const client = createConvStateClient(() =>
        fakeMcp(async () => {
          throw new McpClientError(kind, "boom");
        }),
      );
      expect(await client.convStateGet("opencode:s_1", 500)).toBeNull();
    }
  });

  test("returns null on an unexpected throw", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async () => {
        throw new Error("surprise");
      }),
    );
    expect(await client.convStateGet("opencode:s_1", 500)).toBeNull();
  });

  test("passes the requested timeoutMs to the factory", async () => {
    const timeouts: number[] = [];
    const client = createConvStateClient((timeoutMs) => {
      timeouts.push(timeoutMs);
      return fakeMcp(async () => "No conversation state for x");
    });
    await client.convStateGet("opencode:s_1", 500);
    await client.convStateGet("opencode:s_1", 1000);
    expect(timeouts).toEqual([500, 1000]);
  });
});
