// src/handlers/system-transform.ts
//
// Conv-state injection via opencode's `experimental.chat.system.transform`
// hook — implements §4.9 of the upstream memory-domain-isolation spec
// plus the spec-041 awareness-primer block.
//
// The hook fires per-turn with the assembled system-prompt parts as a
// mutable `output.system: string[]`. From the SINGLE conv_state_get
// response we push the canonical `<conversation-state>` block when a
// state row exists, then the canonical `<librarian>` awareness-primer
// block when the operator-authored primer is non-empty — in that order,
// matching the other four plugins. On a miss/error/empty we leave the
// array untouched. The SDK's safety-fallback (issue tracked at #17100)
// restores the original system array if a plugin empties it, so we can
// never break a user session by mistake here — but as a defensive
// measure we never mutate the input slice or replace its contents.
//
// sessions-rethink PR 4 — the local privacy-state file is retired with
// the rest of the session subsystem. Private mode is now an
// in-conversation `[librarian:private=on|off]` marker the LLM honours
// directly. The conv-state row carries its own `off_record` field
// which the renderer surfaces; the handler does not gate on it.
//
// Fail-soft contract (AGENTS.md §2): every error path returns silently.

import type { Deps } from "../deps.ts";
import { renderAwarenessPrimer, renderConvStateBlock } from "../conv-state-render.ts";

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

    const client = deps.getConvStateClient();
    const result = await client.convStateGet(`opencode:${input.sessionID}`, CONV_STATE_TIMEOUT_MS);
    if (!result) return;

    // Emit from the SINGLE conv_state_get response: the conv-state
    // block first (when there's a row), then the awareness-primer block
    // (when non-empty). The primer is independent of the row, so it
    // survives a null row. Order matches A3–A5: conv-state then primer.
    if (result.state) output.system.push(renderConvStateBlock(result.state));
    const primerBlock = renderAwarenessPrimer(result.primer);
    if (primerBlock) output.system.push(primerBlock);
  } catch (err) {
    const e = err as Error;
    await deps.log({
      event: "experimental.chat.system.transform",
      outcome: "conv_state_threw",
      error: String(e?.message ?? e),
    });
  }
}
