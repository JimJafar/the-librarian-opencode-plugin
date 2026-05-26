// src/index.ts
// the-librarian-opencode-plugin — Plugin factory + hook dispatch.
//
// opencode loads this module on startup. The Plugin function receives an
// `input` with `{ client, project, directory, worktree, $ }` and returns
// a `Hooks` object — a map of hook names to async handlers.
//
// Two responsibilities for the dispatcher itself:
//
//   1. Build the shared dependencies (state-store paths, MCP client
//      factory, logger) once per session and inject them into each
//      handler. Mirrors the Codex plugin's `buildDeps` pattern.
//
//   2. Route opencode's events:
//      - `chat.message` — privacy gate (runs on incoming user messages;
//        pre-LLM if opencode fires it before the model call — verified
//        in smoke).
//      - `event` — generic session lifecycle events, switched on
//        `event.type`: `session.created` (ensure-commands +
//        bootstrap + reconcile), `session.idle` (per-turn record +
//        debounced checkpoint), `session.compacted` (checkpoint),
//        `session.deleted` (pause if attached).
//
// Two invariants every handler obeys, same as the Codex plugin:
//   - Never throw out of a hook (opencode would surface the error;
//     for non-tool hooks this just spams logs, but we want clean
//     behaviour anyway). Wrap everything in try/catch, log to the
//     sidecar, no-op.
//   - Privacy beats convenience. Off-record short-circuits before any
//     server call. See AGENTS.md §2 in this repo.

import type { Plugin, Hooks } from "@opencode-ai/plugin";

const plugin: Plugin = async (_input) => {
  // Handlers wired in Tasks 7–10. Empty hooks object satisfies the type
  // and lets opencode load the plugin successfully.
  const hooks: Hooks = {};
  return hooks;
};

export default plugin;
