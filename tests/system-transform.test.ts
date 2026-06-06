// tests/system-transform.test.ts
//
// Suite for the `experimental.chat.system.transform` handler — mirrors
// the other Librarian plugins' handler tests (the §4.9 + spec-041
// awareness-primer contract is shared; only the input/output shape
// differs).
//
// sessions-rethink PR 4 — the local privacy-state file is gone; the
// handler no longer gates on `state.private`. Private mode is now an
// in-conversation `[librarian:private=on|off]` marker the LLM honours
// directly. The conv-state row's own `off_record` field is surfaced by
// the renderer.
//
// spec 041 PR-6 (A6) — the handler also emits the byte-identical
// `<librarian>` awareness-primer block from the SAME single
// conv_state_get response: conv-state block first (when there's a row),
// then the primer block (when non-empty). The primer survives a null
// row; an empty primer emits no block; every error path is fail-soft.

import { describe, expect, test } from "bun:test";
import { handleSystemTransform } from "../src/handlers/system-transform.ts";
import type { ConvStateResult, ConvStateClient } from "../src/conv-state-client.ts";
import type { Deps } from "../src/deps.ts";

const PRIMER = "PRIMER_TEXT";

function fakeDeps(
  overrides: {
    convStateGet?: ConvStateClient["convStateGet"];
  } = {},
): { deps: Deps; logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = [];
  const deps: Partial<Deps> = {
    getConvStateClient: () =>
      overrides.convStateGet
        ? { convStateGet: overrides.convStateGet }
        : { convStateGet: async () => null },
    log: async (entry) => {
      logs.push(entry);
    },
  };
  return { deps: deps as Deps, logs };
}

function output(initial: string[] = ["BASE_SYSTEM"]): { system: string[] } {
  return { system: [...initial] };
}

const CONV_BLOCK = [
  "<conversation-state>",
  "  conv_id: opencode:s_1",
  "  off_record: false",
  "</conversation-state>",
].join("\n");

const PRIMER_BLOCK = ["<librarian>", PRIMER, "</librarian>"].join("\n");

function rowResult(primer = PRIMER): ConvStateResult {
  return { state: { conv_id: "opencode:s_1", off_record: false }, primer };
}

describe("handleSystemTransform", () => {
  test("appends conv-state then primer blocks on a row+primer hit", async () => {
    let asked: { id: string; t: number } | undefined;
    const { deps } = fakeDeps({
      convStateGet: async (convId, timeoutMs) => {
        asked = { id: convId, t: timeoutMs };
        return rowResult();
      },
    });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(asked).toEqual({ id: "opencode:s_1", t: 500 });
    expect(out.system).toEqual(["BASE_SYSTEM", CONV_BLOCK, PRIMER_BLOCK]);
  });

  test("emits the byte-identical <librarian> block even with no row", async () => {
    const { deps } = fakeDeps({
      convStateGet: async () => ({ state: null, primer: PRIMER }),
    });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(out.system).toEqual(["BASE_SYSTEM", PRIMER_BLOCK]);
  });

  test("emits only the conv-state block when the primer is empty", async () => {
    const { deps } = fakeDeps({ convStateGet: async () => rowResult("") });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(out.system).toEqual(["BASE_SYSTEM", CONV_BLOCK]);
    expect(out.system.join("\n")).not.toContain("<librarian>");
  });

  test("returns silently when there is no row and no primer", async () => {
    const { deps } = fakeDeps({ convStateGet: async () => ({ state: null, primer: "" }) });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(out.system).toEqual(["BASE_SYSTEM"]);
  });

  test("returns silently on a hard miss (convStateGet null)", async () => {
    const { deps } = fakeDeps({ convStateGet: async () => null });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(out.system).toEqual(["BASE_SYSTEM"]);
  });

  test("returns silently when sessionID is absent", async () => {
    let called = false;
    const { deps } = fakeDeps({
      convStateGet: async () => {
        called = true;
        return rowResult();
      },
    });
    const out = output();
    await handleSystemTransform({}, out, deps);
    expect(called).toBe(false);
    expect(out.system).toEqual(["BASE_SYSTEM"]);
  });

  test("logs and leaves system unchanged when convStateGet throws (fail-soft)", async () => {
    const { deps, logs } = fakeDeps({
      convStateGet: async () => {
        throw new Error("boom");
      },
    });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(out.system).toEqual(["BASE_SYSTEM"]);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]).toMatchObject({
      event: "experimental.chat.system.transform",
      outcome: "conv_state_threw",
    });
  });
});
