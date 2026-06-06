// tests/conv-state-client.test.ts
//
// convStateGet wraps the existing MCP client with fail-soft null
// coercion. These cases pin the parsing + error-collapse contract,
// adapted to the A2 (spec 041) JSON shape: conv_state_get now ALWAYS
// returns JSON — `{ ...row, primer }` when a row exists, `{ primer }`
// when not (the old "No conversation state" prose is gone). The client
// surfaces both the row (when present) and the awareness primer.

import { describe, expect, test } from "bun:test";
import { createConvStateClient, type ConvStateRow } from "../src/conv-state-client.ts";
import { McpClientError, type McpClient } from "../src/mcp-client.ts";

function fakeMcp(impl: (name: string, args: Record<string, unknown>) => Promise<string>): McpClient {
  return { callTool: impl };
}

describe("convStateGet", () => {
  test("returns the row and primer on a row+primer hit", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async (name, args) => {
        expect(name).toBe("conv_state_get");
        expect(args).toEqual({ conv_id: "opencode:s_1" });
        return JSON.stringify({
          conv_id: "opencode:s_1",
          off_record: false,
          primer: "PRIMER_TEXT",
        });
      }),
    );
    const result = await client.convStateGet("opencode:s_1", 500);
    // `state` is the WHOLE parsed object — every top-level field
    // (incl. the additive `primer`) rides through it verbatim.
    expect(result).toEqual({
      state: { conv_id: "opencode:s_1", off_record: false, primer: "PRIMER_TEXT" } as ConvStateRow,
      primer: "PRIMER_TEXT",
    });
  });

  test("returns a null row but the primer on the no-row shape", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async () => JSON.stringify({ primer: "PRIMER_TEXT" })),
    );
    const result = await client.convStateGet("opencode:s_1", 500);
    expect(result).toEqual({ state: null, primer: "PRIMER_TEXT" });
  });

  test("primer defaults to \"\" when the field is absent", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async () => JSON.stringify({ conv_id: "opencode:s_1", off_record: false })),
    );
    const result = await client.convStateGet("opencode:s_1", 500);
    expect(result).toEqual({
      state: { conv_id: "opencode:s_1", off_record: false },
      primer: "",
    });
  });

  test("primer defaults to \"\" when explicitly empty (disabled)", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async () => JSON.stringify({ primer: "" })),
    );
    const result = await client.convStateGet("opencode:s_1", 500);
    expect(result).toEqual({ state: null, primer: "" });
  });

  test("primer defaults to \"\" when it is not a string", async () => {
    const client = createConvStateClient(() =>
      fakeMcp(async () => JSON.stringify({ conv_id: "opencode:s_1", primer: 42 })),
    );
    const result = await client.convStateGet("opencode:s_1", 500);
    expect(result).toEqual({
      state: { conv_id: "opencode:s_1", primer: 42 } as ConvStateRow,
      primer: "",
    });
  });

  test("returns null on non-JSON", async () => {
    const client = createConvStateClient(() => fakeMcp(async () => "not json {"));
    expect(await client.convStateGet("opencode:s_1", 500)).toBeNull();
  });

  test("returns null on a non-object JSON payload", async () => {
    const client = createConvStateClient(() => fakeMcp(async () => JSON.stringify("just a string")));
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
      return fakeMcp(async () => JSON.stringify({ primer: "" }));
    });
    await client.convStateGet("opencode:s_1", 500);
    await client.convStateGet("opencode:s_1", 1000);
    expect(timeouts).toEqual([500, 1000]);
  });
});
