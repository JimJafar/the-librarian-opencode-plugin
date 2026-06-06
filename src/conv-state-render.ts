// src/conv-state-render.ts
//
// Canonical `<conversation-state>` block renderer (§4.9 of the
// memory-domain-isolation spec). Byte-identical with the other four
// Librarian plugins' implementations (claude/codex/hermes/pi): the
// block carries `conv_id` + `off_record` only. A change here MUST land
// in lockstep with every other plugin — otherwise the rendered shape
// drifts across harnesses and the cross-harness handover contract
// breaks. See AGENTS.md "five-peer implementations" rule.

import type { ConvStateRow } from "./conv-state-client.ts";

export function renderConvStateBlock(state: ConvStateRow): string {
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>",
  ].join("\n");
}

// Canonical `<librarian>` awareness-primer block (spec 041 Decision 2).
// The primer is an operator-authored note injected every harness turn
// telling the agent it HAS durable memory + which verbs to use. This
// renderer is BYTE-IDENTICAL across all five Librarian plugins
// (claude/codex/hermes/opencode/pi) — a change here MUST land in
// lockstep with every other plugin.
//
// Non-empty primer → exactly three `\n`-joined lines: the col-0
// `<librarian>` open tag, the primer text VERBATIM (NOT indented — it's
// prose, unlike conv-state's 2-space `key: value` fields), the col-0
// `</librarian>` close tag. Empty primer → "" (no block).
export function renderAwarenessPrimer(primer: string): string {
  if (!primer) return "";
  return ["<librarian>", primer, "</librarian>"].join("\n");
}
