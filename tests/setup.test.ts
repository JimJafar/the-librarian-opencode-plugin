// tests/setup.test.ts
// Smoke that the package loads + the exported Plugin is well-formed.
// First test fixture — its job is to fail loudly if a future change
// breaks the public entrypoint.

import { describe, expect, test } from "bun:test";
import plugin from "../src/index.ts";

describe("plugin entrypoint", () => {
  test("default export is an async function (Plugin factory)", () => {
    expect(typeof plugin).toBe("function");
    expect(plugin.constructor.name).toBe("AsyncFunction");
  });

  test("invoking the factory returns a Hooks-shaped object", async () => {
    // Minimal PluginInput stub — we just need the factory to run without
    // touching any real opencode state. Cast through unknown because the
    // real PluginInput requires SDK client / project / etc. that we mock
    // at the boundary, not in this smoke.
    const hooks = await plugin({} as unknown as Parameters<typeof plugin>[0]);
    expect(typeof hooks).toBe("object");
    expect(hooks).not.toBeNull();
  });
});
