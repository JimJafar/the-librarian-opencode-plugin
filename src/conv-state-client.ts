// src/conv-state-client.ts
//
// Conv-state lookup helper for the §4.9 system-prompt injection.
// Wraps the existing MCP client with the fail-soft semantics the spec
// requires: every error path (network, timeout, parse, non-object
// payload) collapses to `null` so the
// `experimental.chat.system.transform` handler can branch only on
// "inject the block(s) or don't", never on error type.
//
// spec 041 (A2) — conv_state_get now ALWAYS returns JSON. With a row
// it is `{ ...row, primer }`; with no row it is `{ primer }` (the old
// "No conversation state …" prose response is gone). So we always
// JSON.parse, treat the payload as a conv-state row ONLY when it
// carries a string `conv_id`, and read the additive top-level `primer`
// field (defaulting to "" when absent / not a string). Both ride the
// SAME single response — no second fetch.

import { createMcpClient, type McpClient, type McpClientConfig } from "./mcp-client.ts";

export interface ConvStateRow {
  conv_id: string;
  off_record?: boolean;
}

/**
 * The parsed conv_state_get response: the conv-state row (when one
 * exists) and the awareness primer (operator-authored, "" when unset
 * or disabled). A hard failure (network/parse/non-object) collapses
 * the whole result to `null`.
 */
export interface ConvStateResult {
  state: ConvStateRow | null;
  primer: string;
}

export interface ConvStateClient {
  /**
   * Resolve the calling conversation's conv_state_get response — the
   * row (or null) plus the awareness primer — or null on any failure.
   */
  convStateGet(convId: string, timeoutMs: number): Promise<ConvStateResult | null>;
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
        return parseResult(text);
      } catch {
        // Every failure → null. The handler treats this exactly the
        // same as a miss; no error escapes to the user's turn.
        return null;
      }
    },
  };
}

function parseResult(text: string): ConvStateResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { conv_id?: unknown; primer?: unknown };
  // A conv-state row only when it carries a string `conv_id`; the
  // no-row shape `{ primer }` has none, so `state` stays null.
  const state = typeof record.conv_id === "string" ? (parsed as ConvStateRow) : null;
  const primer = typeof record.primer === "string" ? record.primer : "";
  return { state, primer };
}
