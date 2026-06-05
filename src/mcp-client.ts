// src/mcp-client.ts
//
// Minimal HTTP MCP client for the Librarian endpoint. Ported from the
// Codex plugin's `src/mcp-client.mjs` — same wire shape, same security
// posture (redirect: error so a 3xx never carries the bearer
// cross-origin; embedded-credentials rejection; query-string rejection
// to prevent ?token=… leaks; response size cap; timeout), strict TS.
//
// Why we have our own client rather than going through opencode's MCP
// layer: the **automatic** conv-state calls need to be enforceable
// locally — off-record and fail-soft are this plugin's invariants, not
// opencode's. The user-facing memory tools (recall, remember, …) still
// go through opencode's MCP via the `mcpServers.librarian` config
// snippet in opencode.json.

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB

export type McpErrorKind =
  | "config"
  | "timeout"
  | "network"
  | "http"
  | "malformed"
  | "rpc";

export class McpClientError extends Error {
  override readonly name = "McpClientError";
  readonly kind: McpErrorKind;
  readonly status?: number;
  constructor(kind: McpErrorKind, message: string, extra: { status?: number } = {}) {
    super(message);
    this.kind = kind;
    this.status = extra.status;
  }
}

export interface McpClientConfig {
  endpoint: string;
  token: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface McpTransportRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface McpTransportResponse {
  status: number;
  body: string;
}

export type McpTransport = (req: McpTransportRequest) => Promise<McpTransportResponse>;

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export function createMcpClient(config: McpClientConfig, transport?: McpTransport): McpClient {
  const url = parseEndpoint(config.endpoint);
  const safeEndpoint = `${url.protocol}//${url.host}${url.pathname}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const send = transport ?? defaultTransport(maxResponseBytes);

  return {
    async callTool(name, args) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`,
      };

      let response: McpTransportResponse;
      try {
        response = await send({ url: config.endpoint, body, headers, timeoutMs });
      } catch (err) {
        if (err instanceof McpClientError) throw err;
        if (isTimeout(err)) {
          throw new McpClientError("timeout", `${name} timed out after ${timeoutMs}ms`);
        }
        throw new McpClientError("network", `${name} could not reach the Librarian at ${safeEndpoint}`);
      }

      if (response.status !== 200) {
        throw new McpClientError("http", `${name} returned HTTP ${response.status}`, {
          status: response.status,
        });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new McpClientError("malformed", `${name} returned non-JSON`);
      }

      if (isRecord(payload) && payload.error != null) {
        const rpc = payload.error;
        const code = isRecord(rpc) ? rpc.code : undefined;
        const msg = isRecord(rpc) ? String(rpc.message ?? "").slice(0, 200) : "";
        throw new McpClientError("rpc", `${name} failed: ${msg} (code ${String(code)})`);
      }

      const text = extractText(payload);
      if (text === null) {
        throw new McpClientError("malformed", `${name} response had no text content`);
      }
      return text;
    },
  };
}

function parseEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new McpClientError("config", "Librarian endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpClientError(
      "config",
      `Librarian endpoint must be http(s), got ${url.protocol.replace(/:$/, "") || "(none)"}`,
    );
  }
  if (url.username || url.password) {
    throw new McpClientError("config", "Librarian endpoint must not embed credentials");
  }
  if (url.search) {
    // A `?token=…` style URL would leak credentials in any logs that
    // capture URLs. The bearer header is the only acceptable carrier.
    throw new McpClientError("config", "Librarian endpoint must not include a query string");
  }
  if (url.hash) {
    // Fragments are technically client-side-only and HTTP clients strip
    // them, but a `#token=…` URL would surprise users; reject for the
    // same "no secrets in URLs" reason as embedded creds / query strings.
    throw new McpClientError("config", "Librarian endpoint must not include a URL fragment");
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimeout(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { code?: unknown }).code;
  return name === "AbortError" || name === "TimeoutError" || code === "ETIMEDOUT";
}

function extractText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const result = payload.result;
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!isRecord(first)) return null;
  return typeof first.text === "string" ? first.text : null;
}

function defaultTransport(maxResponseBytes: number): McpTransport {
  return async ({ url, body, headers, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        headers,
        // Never follow a 3xx — fetch would carry the bearer header to
        // the redirect target and leak the token cross-origin.
        redirect: "error",
        signal: controller.signal,
      });
      return { status: response.status, body: await readCapped(response, maxResponseBytes) };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readCapped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > cap) {
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    return buffer.toString("utf8");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
