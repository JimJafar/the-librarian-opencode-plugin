// tests/source-ref.test.ts
// 100% coverage on source_ref — it's the cross-harness primary key,
// and a drift here would silently fork sessions per machine quirks.

import { describe, expect, test } from "bun:test";
import { buildSourceRef } from "../src/source-ref.ts";

describe("buildSourceRef", () => {
  test("prefers opencode:run form when a runId is provided", () => {
    expect(buildSourceRef({ cwd: "/Users/jim/proj", runId: "ses_oc_abc" })).toBe(
      "opencode:run:ses_oc_abc:cwd:/Users/jim/proj",
    );
  });

  test("falls back to cwd: form when runId is empty/null/missing", () => {
    expect(buildSourceRef({ cwd: "/Users/jim/proj" })).toBe("cwd:/Users/jim/proj");
    expect(buildSourceRef({ cwd: "/Users/jim/proj", runId: "" })).toBe("cwd:/Users/jim/proj");
    expect(buildSourceRef({ cwd: "/Users/jim/proj", runId: null })).toBe("cwd:/Users/jim/proj");
  });

  test("resolves relative cwd against process cwd", () => {
    const ref = buildSourceRef({ cwd: ".", runId: null });
    expect(ref).toMatch(/^cwd:\//);
  });
});
