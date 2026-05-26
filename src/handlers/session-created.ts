// src/handlers/session-created.ts
//
// opencode's `session.created` event fires whenever a new session is
// opened (fresh project, restart, explicit user action). On every
// fire, in order:
//
//   1. **ensure-commands** — idempotently install the seven
//      `lib-session-*.md` files into `~/.config/opencode/commands/`
//      (per Task 0 finding; one-time per user, sentinel prevents
//      churn).
//   2. **bootstrap** — under lock, start a Librarian session if none
//      is attached and we're not off-record. Race-safe.
//   3. **reconcile** — list any other active sessions on this
//      source_ref and pause them. The bootstrap-first order avoids
//      pausing a session a concurrent hook just attached (matches
//      the Codex plugin's RACE GUARD pattern).

import type { Deps } from "../deps.ts";
import { bootstrapSession } from "./session-bootstrap.ts";
import { ensureCommands } from "./ensure-commands.ts";
import { buildSourceRef } from "../source-ref.ts";
import { parseSessionList } from "../mcp-parse.ts";

export interface SessionCreatedInput {
  /** opencode session id from event payload's `info.id`. */
  runId: string | null;
  /** cwd to anchor the source_ref. */
  cwd: string;
}

export async function handleSessionCreated(input: SessionCreatedInput, deps: Deps): Promise<void> {
  await deps.log({ event: "session.created", runId: input.runId });

  // Best-effort install of the markdown command files. Never blocks
  // the bootstrap path.
  await ensureCommands(deps).catch(async (err) => {
    const e = err as Error;
    await deps.log({ event: "session.created", outcome: "ensure_commands_threw", error: String(e?.message ?? e) });
  });

  // Bootstrap FIRST so any concurrent reconcile knows what's ours.
  await bootstrapSession({ cwd: input.cwd, runId: input.runId }, deps);

  await reconcileStaleActive(input, deps);
}

async function reconcileStaleActive(input: SessionCreatedInput, deps: Deps): Promise<void> {
  const stateBefore = await deps.loadState();
  if (stateBefore.private) {
    await deps.log({ event: "session.created", outcome: "reconcile_skipped_private" });
    return;
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "session.created", outcome: "reconcile_skipped_no_client" });
    return;
  }

  const sourceRef = buildSourceRef({ cwd: input.cwd, runId: input.runId });
  let listText = "";
  try {
    listText = await client.callTool("list_sessions", {
      source_ref: sourceRef,
      status: "active",
    });
  } catch (err) {
    const e = err as Error;
    await deps.log({
      event: "session.created",
      outcome: "reconcile_list_failed",
      error: String(e?.message ?? e),
    });
    return;
  }

  const sessions = parseSessionList(listText);
  const ourSessionId = await deps.withLock(async () => {
    const s = await deps.loadState();
    return s.session_id;
  });
  const stale = sessions.filter((s) => s.id !== ourSessionId);

  if (stale.length === 0) {
    await deps.log({ event: "session.created", outcome: "reconcile_no_active" });
    return;
  }

  let paused = 0;
  for (const s of stale) {
    try {
      await client.callTool("pause_session", {
        session_id: s.id,
        summary: "opencode session.created reconciliation",
      });
      paused += 1;
    } catch (err) {
      const e = err as Error;
      await deps.log({
        event: "session.created",
        outcome: "pause_failed",
        session_id: s.id,
        error: String(e?.message ?? e),
      });
    }
  }
  await deps.log({ event: "session.created", outcome: "reconciled", paused });
}
