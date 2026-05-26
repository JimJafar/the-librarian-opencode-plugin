// src/source-ref.ts
//
// The `source_ref` is the cross-harness primary key for a session — it
// lets the same session hand over cleanly between opencode, Claude
// Code, Codex, Hermes, and Pi.
//
// Family-standard shape (per AGENTS.md §4):
//   opencode:run:<opencode-session-id>:cwd:<absolute_path>   when known
//   cwd:<absolute_path>                                       fallback
//
// Note: this is a BREAKING CHANGE from the in-tree
// `integrations/opencode/wrapper.sh` shape which used
// `opencode:project:{cwd}:session:{id}`. The wrapper predates the
// canonical contract; this plugin aligns with the family. Documented
// in the CHANGELOG when v0.1.0 ships.

import path from "node:path";

export interface SourceRefInput {
  cwd: string;
  /** opencode's session id from the event payload's `info.id`. */
  runId?: string | null;
}

export function buildSourceRef({ cwd, runId }: SourceRefInput): string {
  const absCwd = path.resolve(cwd);
  if (typeof runId === "string" && runId.length > 0) {
    return `opencode:run:${runId}:cwd:${absCwd}`;
  }
  return `cwd:${absCwd}`;
}
