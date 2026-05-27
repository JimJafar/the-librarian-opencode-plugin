// src/conv-state-client.ts
//
// Conv-state lookup helper for the §4.9 system-prompt injection.
// Wraps the existing MCP client with the fail-soft semantics the spec
// requires: every error path (network, timeout, parse, malformed row,
// "No conversation state" prose response) collapses to `null` so the
// `experimental.chat.system.transform` handler can branch only on
// "inject the block or don't", never on error type.

import { createMcpClient, type McpClient, type McpClientConfig } from "./mcp-client.ts";

export interface ConvStateRow {
  conv_id: string;
  domain?: string;
  session_id?: string | null;
  off_record?: boolean;
}

export interface ConvStateClient {
  /** Resolve the calling conversation's `conv_state` row, or null on any failure. */
  convStateGet(convId: string, timeoutMs: number): Promise<ConvStateRow | null>;
}

/** Builds an `McpClient` for a single conv-state-get call. */
export type McpFactory = (timeoutMs: number) => McpClient;

/**
 * Production factory bound to a static endpoint + token. Each
 * `convStateGet` call builds a fresh `McpClient` with the requested
 * per-call `timeoutMs` (the underlying client only accepts the
 * timeout at construction time).
 */
export function createConvStateClientFromConfig(
  config: Pick<McpClientConfig, "endpoint" | "token">,
): ConvStateClient {
  return createConvStateClient((timeoutMs) =>
    createMcpClient({ endpoint: config.endpoint, token: config.token, timeoutMs }),
  );
}

export function createConvStateClient(mcpFactory: McpFactory): ConvStateClient {
  return {
    async convStateGet(convId, timeoutMs) {
      try {
        const client = mcpFactory(timeoutMs);
        const text = await client.callTool("conv_state_get", { conv_id: convId });
        if (text.startsWith("No conversation state")) return null;
        return parseRow(text);
      } catch {
        // Every failure → null. The handler treats this exactly the
        // same as a miss; no error escapes to the user's turn.
        return null;
      }
    },
  };
}

function parseRow(text: string): ConvStateRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { conv_id?: unknown };
  if (typeof candidate.conv_id !== "string") return null;
  return parsed as ConvStateRow;
}
