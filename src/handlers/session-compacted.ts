// src/handlers/session-compacted.ts
//
// opencode fires `session.compacted` after compacting the session's
// message history. Most-informative moment to checkpoint — a real
// chunk of conversation just got summarised; forward that signal to
// the Librarian.
//
// No-ops when off-record (privacy invariant) or no session is
// attached (the next bootstrap will create one). Fail-soft on server
// errors.

import type { Deps } from "../deps.ts";

export async function handleSessionCompacted(_input: { sessionID: string }, deps: Deps): Promise<void> {
  await deps.log({ event: "session.compacted" });

  const state = await deps.loadState();
  if (state.private) {
    await deps.log({ event: "session.compacted", outcome: "skipped_private" });
    return;
  }
  if (!state.session_id) {
    await deps.log({ event: "session.compacted", outcome: "no_session" });
    return;
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "session.compacted", outcome: "no_client" });
    return;
  }

  try {
    await client.callTool("checkpoint_session", {
      session_id: state.session_id,
      summary: "opencode compacted the session; rolling summary continues from here.",
    });
  } catch (err) {
    const e = err as Error;
    await deps.log({ event: "session.compacted", outcome: "checkpoint_failed", error: String(e?.message ?? e) });
    return;
  }

  // Reset the debounce counters — a fresh checkpoint just landed.
  await deps.withLock(async () => {
    const latest = await deps.loadState();
    await deps.saveState({
      ...latest,
      last_checkpoint_at: deps.now(),
      turns_since_checkpoint: 0,
    });
  });
  await deps.log({ event: "session.compacted", outcome: "checkpointed", session_id: state.session_id });
}
