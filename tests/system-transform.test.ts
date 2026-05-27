// tests/system-transform.test.ts
//
// Four-case suite for the `experimental.chat.system.transform`
// handler — mirrors the Pi extension's handler tests (the §4.9
// contract is shared; only the input/output shape differs).

import { describe, expect, test } from "bun:test";
import { handleSystemTransform } from "../src/handlers/system-transform.ts";
import type { ConvStateRow, ConvStateClient } from "../src/conv-state-client.ts";
import type { Deps } from "../src/deps.ts";

const STATE: ConvStateRow = {
  conv_id: "opencode:s_1",
  domain: "work",
  session_id: "ses_1",
  off_record: false,
};

function fakeDeps(overrides: Partial<Deps> & {
  privateFlag?: boolean;
  convStateGet?: ConvStateClient["convStateGet"];
} = {}): { deps: Deps; logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = [];
  const deps: Partial<Deps> = {
    loadState: async () => ({
      session_id: null,
      private: overrides.privateFlag ?? false,
      last_checkpoint_at: 0,
      turns_since_checkpoint: 0,
      source_ref: null,
    }),
    getConvStateClient: () =>
      overrides.convStateGet
        ? { convStateGet: overrides.convStateGet }
        : { convStateGet: async () => null },
    log: async (entry) => {
      logs.push(entry);
    },
    ...overrides,
  };
  return { deps: deps as Deps, logs };
}

function output(initial: string[] = ["BASE_SYSTEM"]): { system: string[] } {
  return { system: [...initial] };
}

const BLOCK = [
  "<conversation-state>",
  "  conv_id: opencode:s_1",
  "  domain: work",
  "  session_id: ses_1",
  "  off_record: false",
  "</conversation-state>",
].join("\n");

describe("handleSystemTransform", () => {
  test("appends the canonical block on a state hit", async () => {
    let asked: { id: string; t: number } | undefined;
    const { deps } = fakeDeps({
      convStateGet: async (convId, timeoutMs) => {
        asked = { id: convId, t: timeoutMs };
        return STATE;
      },
    });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(asked).toEqual({ id: "opencode:s_1", t: 500 });
    expect(out.system).toEqual(["BASE_SYSTEM", BLOCK]);
  });

  test("returns silently on a miss (convStateGet null)", async () => {
    const { deps } = fakeDeps({ convStateGet: async () => null });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(out.system).toEqual(["BASE_SYSTEM"]);
  });

  test("never calls convStateGet when off-record", async () => {
    let called = false;
    const { deps } = fakeDeps({
      privateFlag: true,
      convStateGet: async () => {
        called = true;
        return STATE;
      },
    });
    const out = output();
    await handleSystemTransform({ sessionID: "s_1" }, out, deps);
    expect(called).toBe(false);
    expect(out.system).toEqual(["BASE_SYSTEM"]);
  });

  test("returns silently when sessionID is absent", async () => {
    let called = false;
    const { deps } = fakeDeps({
      convStateGet: async () => {
        called = true;
        return STATE;
      },
    });
    const out = output();
    await handleSystemTransform({}, out, deps);
    expect(called).toBe(false);
    expect(out.system).toEqual(["BASE_SYSTEM"]);
  });

  test("logs and returns silently when convStateGet throws", async () => {
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
