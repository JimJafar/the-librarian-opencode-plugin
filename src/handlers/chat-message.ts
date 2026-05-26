// src/handlers/chat-message.ts
//
// Privacy gate. opencode's `chat.message` hook fires when a new user
// message is received, with a mutable `output.message` — meaning it
// runs BEFORE the LLM sees the prompt. This is BETTER than the
// `message.updated` approach the spec originally considered, which
// would have lagged by one turn. With `chat.message` we detect the
// marker pre-model and stop recording on the same turn.
//
// On enter-private: end the attached session with a neutral reason,
// flip state.private. On exit-private: flip state.private back without
// recording. On a toggle command: dispatch to enter or exit based on
// current state. On a non-marker prompt: defensively bootstrap (the
// session.created handler usually handles it, but if for some reason
// chat.message fires first on a fresh state we want to be safe).
//
// **Privacy invariant** (AGENTS.md §2): never let a server outage,
// lock timeout, or parse error leave us recording when the user
// asked us not to. Every privacy transition has an unlocked
// fallback save.

import type { Deps } from "../deps.ts";
import { detectPrivacySignal } from "../privacy-detector.ts";
import { bootstrapSession } from "./session-bootstrap.ts";
import type { PluginState } from "../state-store.ts";

export interface ChatMessageInput {
  /** opencode session id from `input.sessionID`. */
  sessionID: string;
  /** cwd to anchor the source_ref (typically deps.worktree). */
  cwd: string;
  /** Text of the user message — flattened from output.parts at the dispatch site. */
  text: string;
}

export async function handleChatMessage(input: ChatMessageInput, deps: Deps): Promise<void> {
  const { signal, matched } = detectPrivacySignal(input.text);
  await deps.log({ event: "chat.message", text_len: input.text.length, privacy_signal: signal });

  switch (signal) {
    case "enter-private":
      await goPrivate(deps, { reason: matched ?? "marker" });
      return;
    case "exit-private":
      await goPublic(deps, { reason: matched ?? "marker" });
      return;
    case "toggle": {
      const state = await deps.loadState();
      if (state.private) await goPublic(deps, { reason: "toggle" });
      else await goPrivate(deps, { reason: "toggle" });
      return;
    }
    case "none":
    default:
      // Defensive bootstrap. session.created usually handles this; we
      // re-do it here in case the events fire in unexpected order.
      await bootstrapSession({ cwd: input.cwd, runId: input.sessionID, seedPrompt: input.text }, deps).catch(
        async (err) => {
          const e = err as Error;
          await deps.log({ event: "chat.message", outcome: "bootstrap_threw", error: String(e?.message ?? e) });
        },
      );
  }
}

async function goPrivate(deps: Deps, { reason }: { reason: string }): Promise<void> {
  try {
    await deps.withLock(async () => {
      const state = await deps.loadState();
      if (state.private) {
        await deps.log({ event: "chat.message", outcome: "already_private", matched: reason });
        return;
      }
      await endAttachedSessionIfAny(state, deps);
      await deps.saveState({ ...state, session_id: null, source_ref: null, private: true });
      await deps.log({ event: "chat.message", outcome: "entered_private", matched: reason });
    });
  } catch (err) {
    // Lock failure → unlocked fallback. Privacy invariant beats atomicity.
    const e = err as Error;
    await deps.log({ event: "chat.message", outcome: "lock_failed_fallback_to_unlocked", error: String(e?.message ?? e) });
    try {
      const state = await deps.loadState();
      await endAttachedSessionIfAny(state, deps);
      await deps.saveState({ ...state, session_id: null, source_ref: null, private: true });
    } catch (err2) {
      const e2 = err2 as Error;
      await deps.log({ event: "chat.message", outcome: "fallback_save_failed", error: String(e2?.message ?? e2) });
    }
  }
}

async function endAttachedSessionIfAny(state: PluginState, deps: Deps): Promise<void> {
  if (!state.session_id) return;
  const client = deps.getClient();
  if (!client) return;
  try {
    await client.callTool("end_session", {
      session_id: state.session_id,
      summary: "switching to private mode",
    });
  } catch (err) {
    const e = err as Error;
    await deps.log({
      event: "chat.message",
      outcome: "end_session_failed_during_enter_private",
      error: String(e?.message ?? e),
    });
  }
}

async function goPublic(deps: Deps, { reason }: { reason: string }): Promise<void> {
  try {
    await deps.withLock(async () => {
      const state = await deps.loadState();
      if (!state.private) {
        await deps.log({ event: "chat.message", outcome: "already_public", matched: reason });
        return;
      }
      await deps.saveState({ ...state, private: false });
      await deps.log({ event: "chat.message", outcome: "exited_private", matched: reason });
    });
  } catch (err) {
    const e = err as Error;
    await deps.log({ event: "chat.message", outcome: "lock_failed_fallback_to_unlocked_exit", error: String(e?.message ?? e) });
    try {
      const state = await deps.loadState();
      if (state.private) await deps.saveState({ ...state, private: false });
    } catch {
      /* user can retry with another marker */
    }
  }
}
