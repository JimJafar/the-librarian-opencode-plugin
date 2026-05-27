// src/handlers/system-transform.ts
//
// Conv-state injection via opencode's `experimental.chat.system.transform`
// hook — implements §4.9 of the upstream memory-domain-isolation spec.
//
// The hook fires per-turn with the assembled system-prompt parts as a
// mutable `output.system: string[]`. We push the canonical
// `<conversation-state>` block onto `output.system` when a state row
// exists; otherwise we leave the array untouched. The SDK's
// safety-fallback (issue tracked at #17100) restores the original
// system array if a plugin empties it, so we can never break a user
// session by mistake here — but as a defensive measure we never
// mutate the input slice or replace its contents.
//
// Fail-soft contract (AGENTS.md §2): every error path returns silently.
// Off-record sessions skip the MCP call entirely; the privacy gate
// always runs BEFORE the convStateGet so a private state can never
// observe network activity from this handler.

import type { Deps } from "../deps.ts";
import { renderConvStateBlock } from "../conv-state-render.ts";

const CONV_STATE_TIMEOUT_MS = 500;

export interface SystemTransformInput {
  sessionID?: string;
}

export interface SystemTransformOutput {
  system: string[];
}

export async function handleSystemTransform(
  input: SystemTransformInput,
  output: SystemTransformOutput,
  deps: Deps,
): Promise<void> {
  try {
    if (!input.sessionID) return;

    // Privacy gate first — an off-record session must never produce
    // network activity from this handler.
    const state = await deps.loadState();
    if (state.private) return;

    const client = deps.getConvStateClient();
    const row = await client.convStateGet(`opencode:${input.sessionID}`, CONV_STATE_TIMEOUT_MS);
    if (!row) return;

    output.system.push(renderConvStateBlock(row));
  } catch (err) {
    const e = err as Error;
    await deps.log({
      event: "experimental.chat.system.transform",
      outcome: "conv_state_threw",
      error: String(e?.message ?? e),
    });
  }
}
