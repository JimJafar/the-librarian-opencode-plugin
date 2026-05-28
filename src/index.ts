// src/index.ts
// the-librarian-opencode-plugin — Plugin factory + hook dispatch.
//
// opencode loads this module on startup. The exported Plugin function
// receives an `input` with `{ client, project, directory, worktree, $ }`
// and returns a `Hooks` object — a map of hook names to async handlers.
//
// sessions-rethink PR 4 — the only remaining hook is
// `experimental.chat.system.transform`, which performs conv-state
// injection per spec §4.9. The session lifecycle (chat.message privacy
// gate, session.created bootstrap + reconcile, session.idle per-turn
// record, session.compacted checkpoint) is retired.
//
// `ensureCommands` runs once at plugin init now that there is no
// session.created hook to drive it — it idempotently installs the four
// new slash-command markdown files (handoff, takeover, learn,
// toggle-private) into `~/.config/opencode/commands/` so opencode picks
// them up on its next directory scan.
//
// Two invariants every handler obeys:
//   1. Never throw out of a hook. Wrap in try/catch, log to the
//      sidecar, no-op.
//   2. Privacy beats convenience. An off-record session must never
//      produce network activity from any handler. See AGENTS.md §2.

import type { Plugin, Hooks } from "@opencode-ai/plugin";
import os from "node:os";
import path from "node:path";
import { buildDeps } from "./deps.ts";
import { ensureCommands } from "./handlers/ensure-commands.ts";
import { handleSystemTransform } from "./handlers/system-transform.ts";

const DATA_DIR_NAME = "the-librarian-opencode-plugin";

function defaultDataDir(): string {
  // ~/.local/share/the-librarian-opencode-plugin/ on Linux; macOS doesn't
  // have an XDG default, so we use the same path under $HOME for cross-
  // platform consistency.
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, DATA_DIR_NAME);
  return path.join(os.homedir(), ".local", "share", DATA_DIR_NAME);
}

const plugin: Plugin = async (input) => {
  const deps = buildDeps({
    dataDir: process.env.LIBRARIAN_PLUGIN_DATA ?? defaultDataDir(),
    worktree: input.worktree ?? input.directory,
  });

  // One-shot, idempotent install of the four slash-command markdown
  // files into the user's opencode commands directory. Best-effort — a
  // failure is logged but never throws. Sentinel-guarded so subsequent
  // plugin loads at the same version short-circuit.
  await ensureCommands(deps).catch(async (err) => {
    const e = err as Error;
    await deps.log({
      event: "plugin_init",
      outcome: "ensure_commands_threw",
      error: String(e?.message ?? e),
    });
  });

  const safe = <T>(label: string, fn: () => Promise<T>): Promise<T | void> =>
    fn().catch(async (err: unknown) => {
      const e = err as Error;
      await deps.log({ event: label, outcome: "handler_threw", error: String(e?.message ?? e) });
    });

  const hooks: Hooks = {
    "experimental.chat.system.transform": async (input, output) => {
      // §4.9 conv-state injection. The handler is fail-soft end-to-end
      // and never mutates `output.system` on the miss/error paths — it
      // only `.push()`es when a state row exists. The SDK safety
      // fallback (issue tracked in opencode's #17100) restores the
      // original system array if a plugin empties it; we never do
      // that, but the eyeball-test gate verifies the additive path
      // reaches the model.
      await safe("experimental.chat.system.transform", () =>
        handleSystemTransform(input, output, deps),
      );
    },
  };
  return hooks;
};

export default plugin;
