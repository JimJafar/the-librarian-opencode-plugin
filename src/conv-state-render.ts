// src/conv-state-render.ts
//
// Canonical `<conversation-state>` block renderer (§4.9 of the
// memory-domain-isolation spec). Byte-identical with the other four
// Librarian plugins' implementations (claude/codex/hermes/pi). A
// change here MUST land in lockstep with every other plugin —
// otherwise the rendered shape drifts across harnesses and the
// cross-harness handover contract breaks. See AGENTS.md "five-peer
// implementations" rule.

import type { ConvStateRow } from "./conv-state-client.ts";

export function renderConvStateBlock(state: ConvStateRow): string {
  const sessionId = state.session_id ?? "none";
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  domain: ${state.domain}`,
    `  session_id: ${sessionId}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>",
  ].join("\n");
}
