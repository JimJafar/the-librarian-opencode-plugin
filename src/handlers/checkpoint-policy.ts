// src/handlers/checkpoint-policy.ts
//
// Same OR-of-conditions debounce as the Codex plugin — checkpoint
// when EITHER 10 minutes have elapsed since last_checkpoint_at OR
// 20 record_session_event calls have happened since the last
// checkpoint. PostCompact + session.compacted always checkpoint
// independently.

import type { PluginState } from "../state-store.ts";

export const CHECKPOINT_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
export const CHECKPOINT_MAX_TURNS = 20;

export function shouldCheckpoint(state: PluginState | null | undefined, now: number): boolean {
  if (!state) return false;
  const elapsed = now - (state.last_checkpoint_at ?? 0);
  if (elapsed >= CHECKPOINT_MIN_INTERVAL_MS) return true;
  if ((state.turns_since_checkpoint ?? 0) >= CHECKPOINT_MAX_TURNS) return true;
  return false;
}
