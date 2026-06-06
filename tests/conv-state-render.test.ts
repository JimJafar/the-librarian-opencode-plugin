// tests/conv-state-render.test.ts
//
// Snapshot test for the canonical §4.9 block. Byte-identical with the
// other four plugins' implementations; this test pins the exact shape.

import { describe, expect, test } from "bun:test";
import { renderAwarenessPrimer, renderConvStateBlock } from "../src/conv-state-render.ts";

describe("renderConvStateBlock", () => {
  test("renders the canonical §4.9 block exactly", () => {
    const block = renderConvStateBlock({
      conv_id: "opencode:s_1",
      off_record: false,
    });
    expect(block).toBe(
      [
        "<conversation-state>",
        "  conv_id: opencode:s_1",
        "  off_record: false",
        "</conversation-state>",
      ].join("\n"),
    );
  });

  test("renders off_record as the boolean literal string", () => {
    const block = renderConvStateBlock({
      conv_id: "opencode:s_1",
      off_record: true,
    });
    expect(block).toContain("  off_record: true");
  });

  test("carries no retired domain / session_id lines", () => {
    const block = renderConvStateBlock({
      conv_id: "opencode:s_1",
      off_record: false,
    });
    expect(block).toContain("  conv_id: opencode:s_1");
    expect(block).toContain("  off_record: false");
    expect(block).not.toContain("domain:");
    expect(block).not.toContain("session_id:");
  });
});

describe("renderAwarenessPrimer", () => {
  test("renders the canonical <librarian> block byte-identically", () => {
    const primer =
      "You have The Librarian: durable, cross-session memory. Use `recall` to check what's already known before asking; use `remember` / `/learn` to save durable facts, preferences, and decisions worth keeping.";
    expect(renderAwarenessPrimer(primer)).toBe(`<librarian>\n${primer}\n</librarian>`);
  });

  test("joins col-0 tags around the primer verbatim with \\n", () => {
    expect(renderAwarenessPrimer("hello")).toBe(["<librarian>", "hello", "</librarian>"].join("\n"));
  });

  test("preserves a multi-line primer verbatim (no indentation)", () => {
    expect(renderAwarenessPrimer("a\nb")).toBe("<librarian>\na\nb\n</librarian>");
  });

  test("returns the empty string for an empty primer (no block)", () => {
    expect(renderAwarenessPrimer("")).toBe("");
  });
});
