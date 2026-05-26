// src/index.ts
// the-librarian-opencode-plugin — Plugin factory + hook dispatch.
//
// opencode loads this module on startup. The exported Plugin
// function receives an `input` with `{ client, project, directory,
// worktree, $ }` and returns a `Hooks` object — a map of hook
// names to async handlers.
//
// Routing:
//   - `chat.message` — privacy gate. Pre-LLM (mutable output), so
//     off-record markers stop recording on the SAME turn (no
//     one-turn lag).
//   - `event` — generic session lifecycle events. We switch on
//     `event.type` for `session.created` (ensure-commands +
//     bootstrap + reconcile), `session.idle` (per-turn record +
//     debounced checkpoint), `session.compacted` (checkpoint).
//
// Two invariants every handler obeys:
//   1. Never throw out of a hook. Wrap in try/catch, log to the
//      sidecar, no-op.
//   2. Privacy beats convenience. Off-record short-circuits before
//      any server call. See AGENTS.md §2.

import type { Plugin, Hooks } from "@opencode-ai/plugin";
import os from "node:os";
import path from "node:path";
import { buildDeps } from "./deps.ts";
import { handleSessionCreated } from "./handlers/session-created.ts";
import { handleSessionCompacted } from "./handlers/session-compacted.ts";
import { handleSessionIdle } from "./handlers/session-idle.ts";
import { handleChatMessage } from "./handlers/chat-message.ts";

const DATA_DIR_NAME = "the-librarian-opencode-plugin";

function defaultDataDir(): string {
  // ~/.local/share/the-librarian-opencode-plugin/ on Linux; macOS
  // doesn't have an XDG default, so we use the same path under $HOME
  // for cross-platform consistency.
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, DATA_DIR_NAME);
  return path.join(os.homedir(), ".local", "share", DATA_DIR_NAME);
}

const plugin: Plugin = async (input) => {
  const deps = buildDeps({
    dataDir: process.env.LIBRARIAN_PLUGIN_DATA ?? defaultDataDir(),
    worktree: input.worktree ?? input.directory,
  });

  // Hook handlers — every wrap log+swallow so a thrown error never
  // makes it back to opencode.
  const safe =
    <T>(label: string, fn: () => Promise<T>): Promise<T | void> =>
      fn().catch(async (err: unknown) => {
        const e = err as Error;
        await deps.log({ event: label, outcome: "handler_threw", error: String(e?.message ?? e) });
      });

  const hooks: Hooks = {
    "chat.message": async (_input, output) => {
      const text = (output.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n");
      await safe("chat.message", () =>
        handleChatMessage({ sessionID: _input.sessionID, cwd: deps.worktree, text }, deps),
      );
    },
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
          await safe("session.created", () =>
            handleSessionCreated({ runId: event.properties.info.id, cwd: deps.worktree }, deps),
          );
          break;
        case "session.idle":
          await safe("session.idle", () =>
            handleSessionIdle({ sessionID: event.properties.sessionID }, deps),
          );
          break;
        case "session.compacted":
          await safe("session.compacted", () =>
            handleSessionCompacted({ sessionID: event.properties.sessionID }, deps),
          );
          break;
        default:
        // ignore — opencode emits many events we don't subscribe to
      }
    },
  };
  return hooks;
};

export default plugin;
