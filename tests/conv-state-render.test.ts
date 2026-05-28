// tests/conv-state-render.test.ts
//
// Snapshot test for the canonical §4.9 block. Byte-identical with the
// other four plugins' implementations; this test pins the exact shape.

import { describe, expect, test } from "bun:test";
import type { ConvStateRow } from "../src/conv-state-client.ts";
import { renderConvStateBlock } from "../src/conv-state-render.ts";

describe("renderConvStateBlock", () => {
  test("renders the canonical §4.9 block exactly", () => {
    const block = renderConvStateBlock({
      conv_id: "opencode:s_1",
      domain: "work",
      session_id: "ses_1",
      off_record: false,
    });
    expect(block).toBe(
      [
        "<conversation-state>",
        "  conv_id: opencode:s_1",
        "  domain: work",
        "  session_id: ses_1",
        "  off_record: false",
        "</conversation-state>",
      ].join("\n"),
    );
  });

  test("falls back to session_id: none when the row has no session", () => {
    const block = renderConvStateBlock({
      conv_id: "opencode:s_1",
      domain: "personal",
      session_id: null,
      off_record: false,
    });
    expect(block).toContain("  session_id: none");
  });

  test("renders off_record as the boolean literal string", () => {
    const block = renderConvStateBlock({
      conv_id: "opencode:s_1",
      domain: "personal",
      session_id: "ses_1",
      off_record: true,
    });
    expect(block).toContain("  off_record: true");
  });

  test("falls back to `domain: unknown` (never the literal `undefined`) if a malformed row reaches the renderer at runtime", () => {
    const malformed = {
      conv_id: "opencode:s_1",
      session_id: "ses_1",
      off_record: false,
    } as unknown as ConvStateRow;
    const block = renderConvStateBlock(malformed);
    expect(block).toContain("  domain: unknown");
    expect(block).not.toContain("undefined");
  });
});
