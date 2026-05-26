// src/handlers/session-bootstrap.ts
//
// Shared bootstrap — called from `session.created` and (defensively)
// from `chat.message` to ensure a Librarian session is attached.
// Idempotent under any race: the lock-guarded read-then-write makes
// one caller win and the other observe `state.session_id` already
// set and bail.
//
// Off-record: returns the unchanged state without ever calling the
// server. A bootstrap is the start of recording — if the user is
// private, doing nothing is correct.
//
// Fail-soft: a Librarian/network failure leaves state unchanged (no
// session attached) and logs. The next hook event will retry.

import { buildSourceRef } from "../source-ref.ts";
import { extractSessionId } from "../mcp-parse.ts";
import type { Deps } from "../deps.ts";
import type { PluginState } from "../state-store.ts";

const HARNESS = "opencode";

export interface BootstrapInput {
  /** opencode session id from event payload. */
  runId: string | null;
  /** cwd to anchor the source_ref (typically deps.worktree). */
  cwd: string;
  /** Optional seed text to include in start_summary (e.g. first user prompt). */
  seedPrompt?: string;
}

export async function bootstrapSession(input: BootstrapInput, deps: Deps): Promise<PluginState> {
  return deps.withLock(async () => {
    const state = await deps.loadState();
    if (state.private) {
      await deps.log({ event: "bootstrap", outcome: "skipped_private" });
      return state;
    }
    if (state.session_id) {
      await deps.log({ event: "bootstrap", outcome: "already_attached", session_id: state.session_id });
      return state;
    }
    const client = deps.getClient();
    if (!client) {
      await deps.log({ event: "bootstrap", outcome: "no_client" });
      return state;
    }

    const sourceRef = buildSourceRef({ cwd: input.cwd, runId: input.runId });
    const args: Record<string, unknown> = {
      harness: HARNESS,
      source_ref: sourceRef,
      cwd: input.cwd,
      visibility: "common",
      capture_mode: "summary",
      start_summary: deriveStartSummary(input),
    };
    if (deps.env.LIBRARIAN_PROJECT_KEY) args.project_key = deps.env.LIBRARIAN_PROJECT_KEY;

    let sessionId: string | null = null;
    try {
      const text = await client.callTool("start_session", args);
      sessionId = extractSessionId(text);
    } catch (err) {
      const e = err as Error;
      await deps.log({ event: "bootstrap", outcome: "start_failed", error: String(e?.message ?? e) });
      return state;
    }

    if (!sessionId) {
      await deps.log({ event: "bootstrap", outcome: "no_session_id_in_response" });
      return state;
    }

    const updated: PluginState = {
      ...state,
      session_id: sessionId,
      source_ref: sourceRef,
      last_checkpoint_at: deps.now(),
      turns_since_checkpoint: 0,
    };
    await deps.saveState(updated);
    await deps.log({ event: "bootstrap", outcome: "started", session_id: sessionId, source_ref: sourceRef });
    return updated;
  });
}

function deriveStartSummary(input: BootstrapInput): string {
  const parts: string[] = [];
  parts.push(`Working in ${input.cwd}.`);
  const prompt = (input.seedPrompt ?? "").trim();
  if (prompt) {
    const seed = prompt.length > 240 ? `${prompt.slice(0, 240)}…` : prompt;
    parts.push(`Opening prompt: ${seed}`);
  }
  return parts.join(" ");
}
