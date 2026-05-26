// src/deps.ts
//
// Shared dependencies injected into every handler — state-store
// adapters, MCP client factory, logger, clock, env access. Built once
// per plugin invocation in src/index.ts and passed through. This is
// the seam that lets every handler be unit-tested with mocks.

import { createMcpClient, type McpClient } from "./mcp-client.ts";
import { loadState, saveState, withLock, type PluginState } from "./state-store.ts";
import { log as fileLog } from "./log.ts";

export interface Deps {
  dataDir: string;
  worktree: string;
  loadState: () => Promise<PluginState>;
  saveState: (state: PluginState) => Promise<void>;
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Returns null when LIBRARIAN_MCP_URL/TOKEN are unset OR dataDir is missing. */
  getClient: () => McpClient | null;
  log: (entry: Record<string, unknown>) => Promise<void>;
  now: () => number;
  env: NodeJS.ProcessEnv;
}

export function buildDeps(opts: { dataDir: string; worktree: string; env?: NodeJS.ProcessEnv }): Deps {
  const env = opts.env ?? process.env;
  const { dataDir, worktree } = opts;
  const endpoint = env.LIBRARIAN_MCP_URL;
  const token = env.LIBRARIAN_AGENT_TOKEN;

  // Lazy client — a hook that doesn't need to call the server (e.g.
  // off-record) shouldn't fail because env vars are unset. Refuse to
  // construct without a dataDir: with no persistent state we can't
  // detect "session already attached" and we'd spam start_session.
  let cached: McpClient | null = null;
  const getClient = (): McpClient | null => {
    if (cached) return cached;
    if (!dataDir || !endpoint || !token) return null;
    try {
      cached = createMcpClient({ endpoint, token });
    } catch {
      cached = null;
    }
    return cached;
  };

  return {
    dataDir,
    worktree,
    loadState: () => loadState(dataDir),
    saveState: (state) => saveState(dataDir, state),
    withLock: (fn) => withLock(dataDir, fn),
    getClient,
    log: (entry) => fileLog(dataDir, entry),
    now: () => Date.now(),
    env,
  };
}
