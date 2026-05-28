// src/deps.ts
//
// Shared dependencies injected into every handler — logger, conv-state
// client factory, clock, env access. Built once per plugin invocation in
// src/index.ts and passed through. This is the seam that lets every
// handler be unit-tested with mocks.
//
// sessions-rethink PR 4 — the session-specific deps (state-store
// adapter, generic MCP client for the session lifecycle, withLock)
// are retired with the rest of the session subsystem. Only the
// conv-state client surface survives.

import { createConvStateClientFromConfig, type ConvStateClient } from "./conv-state-client.ts";
import { log as fileLog } from "./log.ts";

export interface Deps {
  dataDir: string;
  worktree: string;
  /**
   * Returns a per-call conv-state client; the underlying McpClient is
   * built per call so the requested timeoutMs can be honoured. When the
   * Librarian is unconfigured the client is still returned but its
   * `convStateGet` will resolve null (the McpClient factory throws on
   * construction and the conv-state client catches).
   */
  getConvStateClient: () => ConvStateClient;
  log: (entry: Record<string, unknown>) => Promise<void>;
  now: () => number;
  env: NodeJS.ProcessEnv;
}

export function buildDeps(opts: {
  dataDir: string;
  worktree: string;
  env?: NodeJS.ProcessEnv;
}): Deps {
  const env = opts.env ?? process.env;
  const { dataDir, worktree } = opts;
  const endpoint = env.LIBRARIAN_MCP_URL;
  const token = env.LIBRARIAN_AGENT_TOKEN;

  const getConvStateClient = (): ConvStateClient =>
    createConvStateClientFromConfig({ endpoint: endpoint ?? "", token: token ?? "" });

  return {
    dataDir,
    worktree,
    getConvStateClient,
    log: (entry) => fileLog(dataDir, entry),
    now: () => Date.now(),
    env,
  };
}
