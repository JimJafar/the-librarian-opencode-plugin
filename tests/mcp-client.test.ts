// tests/mcp-client.test.ts
//
// Security-critical assertions on the MCP HTTP client carrying the
// bearer token to the Librarian. Mirrors the Codex plugin's
// mcp-client.test.mjs — the wire contract is identical, only the
// language changes.

import { describe, expect, test } from "bun:test";
import {
  createMcpClient,
  McpClientError,
  type McpTransport,
  type McpTransportRequest,
  type McpTransportResponse,
} from "../src/mcp-client.ts";

interface FakeTransport extends McpTransport {
  calls: McpTransportRequest[];
}

function fakeTransport(
  handler: (req: McpTransportRequest) => McpTransportResponse | Promise<McpTransportResponse>,
): FakeTransport {
  const calls: McpTransportRequest[] = [];
  const fn = (async (req) => {
    calls.push(req);
    return handler(req);
  }) as FakeTransport;
  fn.calls = calls;
  return fn;
}

describe("mcp-client", () => {
  test("callTool POSTs a tools/call JSON-RPC envelope with the bearer header", async () => {
    const transport = fakeTransport(() => ({
      status: 200,
      body: JSON.stringify({ result: { content: [{ text: "hi" }] } }),
    }));
    const client = createMcpClient(
      { endpoint: "https://example.com/mcp", token: "tok_abc" },
      transport,
    );
    const text = await client.callTool("recall", { query: "foo" });
    expect(text).toBe("hi");
    expect(transport.calls.length).toBe(1);
    const req = transport.calls[0]!;
    expect(req.url).toBe("https://example.com/mcp");
    expect(req.headers.Authorization).toBe("Bearer tok_abc");
    const body = JSON.parse(req.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("recall");
    expect(body.params.arguments).toEqual({ query: "foo" });
  });

  test("a non-200 response throws an http-kind McpClientError carrying the status", async () => {
    const transport = fakeTransport(() => ({ status: 502, body: "" }));
    const client = createMcpClient({ endpoint: "https://example.com/mcp", token: "t" }, transport);
    const err = await client.callTool("recall", {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpClientError);
    expect((err as McpClientError).kind).toBe("http");
    expect((err as McpClientError).status).toBe(502);
  });

  test("a JSON-RPC error payload throws an rpc-kind McpClientError", async () => {
    const transport = fakeTransport(() => ({
      status: 200,
      body: JSON.stringify({ error: { code: -32603, message: "internal" } }),
    }));
    const client = createMcpClient({ endpoint: "https://example.com/mcp", token: "t" }, transport);
    const err = await client.callTool("recall", {}).catch((e) => e);
    expect((err as McpClientError).kind).toBe("rpc");
    expect((err as McpClientError).message).toMatch(/internal/);
  });

  test("a non-JSON body throws a malformed-kind McpClientError", async () => {
    const transport = fakeTransport(() => ({ status: 200, body: "<html>" }));
    const client = createMcpClient({ endpoint: "https://example.com/mcp", token: "t" }, transport);
    const err = await client.callTool("recall", {}).catch((e) => e);
    expect((err as McpClientError).kind).toBe("malformed");
  });

  test("rejects a non-http(s) endpoint at construction time", () => {
    expect(() => createMcpClient({ endpoint: "ftp://example.com/mcp", token: "t" })).toThrow(McpClientError);
  });

  test("rejects an endpoint that embeds credentials", () => {
    expect(() => createMcpClient({ endpoint: "https://user:pw@example.com/mcp", token: "t" })).toThrow(McpClientError);
  });

  test("rejects an endpoint with a query string", () => {
    expect(() => createMcpClient({ endpoint: "https://example.com/mcp?token=x", token: "t" })).toThrow(McpClientError);
  });
});

describe("mcp-parse", () => {
  test("extractSessionId picks up hyphenated UUID-style ids", async () => {
    const { extractSessionId } = await import("../src/mcp-parse.ts");
    expect(extractSessionId("ID: ses_01a26887-03a1-4f35-bf2f-9b119213f663")).toBe(
      "ses_01a26887-03a1-4f35-bf2f-9b119213f663",
    );
  });

  test("extractSessionId picks up underscore-bearing ids defensively", async () => {
    const { extractSessionId } = await import("../src/mcp-parse.ts");
    expect(extractSessionId("ID: ses_old_active")).toBe("ses_old_active");
  });

  test("parseSessionList parses numbered list entries with id lines", async () => {
    const { parseSessionList } = await import("../src/mcp-parse.ts");
    const text = [
      "Sessions:",
      "",
      "1. [active] one — proj — codex — cwd:/p — t — n",
      "   id: ses_one",
      "2. [paused] two — proj — codex — cwd:/p — t — n",
      "   id: ses_two",
    ].join("\n");
    const sessions = parseSessionList(text);
    expect(sessions).toEqual([
      { id: "ses_one", status: "active", title: "one — proj — codex — cwd:/p — t — n" },
      { id: "ses_two", status: "paused", title: "two — proj — codex — cwd:/p — t — n" },
    ]);
  });

  test("parseSessionList returns empty for no-matches text", async () => {
    const { parseSessionList } = await import("../src/mcp-parse.ts");
    expect(parseSessionList("No sessions found.")).toEqual([]);
  });
});
