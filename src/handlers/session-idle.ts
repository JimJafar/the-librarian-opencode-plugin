// src/handlers/session-idle.ts
//
// opencode's `session.idle` fires after a turn completes (model
// stopped generating, no pending tool calls). Two responsibilities:
//
//   1. Record a per-turn `record_session_event` (type=message,
//      summary capped at 280 chars). The opencode `session.idle`
//      payload doesn't include the last assistant message text, so
//      we record a generic per-turn marker and let the Librarian
//      server's own summary roll-up handle the content.
//   2. Apply the debounced checkpoint policy (see
//      ./checkpoint-policy.ts).
//
// No-ops off-record / without an attached session / without a client.

import type { Deps } from "../deps.ts";
import { shouldCheckpoint } from "./checkpoint-policy.ts";

export async function handleSessionIdle(_input: { sessionID: string }, deps: Deps): Promise<void> {
  await deps.log({ event: "session.idle" });

  const state = await deps.loadState();
  if (state.private) {
    await deps.log({ event: "session.idle", outcome: "skipped_private" });
    return;
  }
  if (!state.session_id) {
    await deps.log({ event: "session.idle", outcome: "no_session" });
    return;
  }
  const client = deps.getClient();
  if (!client) {
    await deps.log({ event: "session.idle", outcome: "no_client" });
    return;
  }

  // Acceptable race: state.session_id was read without the lock. If a
  // concurrent chat.message goPrivate slipped in, one last event
  // records to the (now-ended) session. The alternative — holding
  // the lock across a 15s HTTP POST — would block every other hook.
  try {
    await client.callTool("record_session_event", {
      session_id: state.session_id,
      type: "message",
      summary: "opencode turn completed",
    });
  } catch (err) {
    const e = err as Error;
    await deps.log({ event: "session.idle", outcome: "record_failed", error: String(e?.message ?? e) });
    return; // Skip the checkpoint check too — retry next turn.
  }

  await deps.withLock(async () => {
    const latest = await deps.loadState();
    const turns = (latest.turns_since_checkpoint ?? 0) + 1;
    const probe = { ...latest, turns_since_checkpoint: turns };
    const now = deps.now();

    if (shouldCheckpoint(probe, now)) {
      try {
        await client.callTool("checkpoint_session", {
          session_id: latest.session_id!,
          summary: `Debounced checkpoint (${turns} turn${turns === 1 ? "" : "s"} since last).`,
        });
        await deps.saveState({
          ...latest,
          turns_since_checkpoint: 0,
          last_checkpoint_at: now,
        });
        await deps.log({ event: "session.idle", outcome: "checkpointed", turns });
      } catch (err) {
        // Checkpoint failed; keep the counter incremented so the next
        // session.idle retries the threshold check.
        await deps.saveState({ ...latest, turns_since_checkpoint: turns });
        const e = err as Error;
        await deps.log({ event: "session.idle", outcome: "checkpoint_failed", error: String(e?.message ?? e) });
      }
    } else {
      await deps.saveState({ ...latest, turns_since_checkpoint: turns });
    }
  });
}
