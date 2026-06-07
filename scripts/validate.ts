#!/usr/bin/env bun
// scripts/validate.ts
// Pre-commit / pre-tag shape check. Exits 0 with `OK` on success;
// exits 1 with a list of findings on failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors: string[] = [];

function fail(msg: string): void {
  errors.push(msg);
}

function readJsonOrFail<T = unknown>(rel: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8")) as T;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    fail(`${rel}: ${e.code === "ENOENT" ? "missing" : `invalid JSON (${e.message})`}`);
    return null;
  }
}

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  type?: string;
  main?: string;
  exports?: unknown;
  "oc-plugin"?: unknown;
  files?: string[];
  peerDependencies?: Record<string, string>;
}

function checkPackageJson(): void {
  const pkg = readJsonOrFail<PackageJson>("package.json");
  if (!pkg) return;
  if (pkg.name !== "the-librarian-opencode-plugin") fail(`package.json: name must be the-librarian-opencode-plugin`);
  if (!pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) fail(`package.json: version must be semver`);
  if (!pkg.description) fail(`package.json: description is required`);
  if (pkg.type !== "module") fail(`package.json: type must be "module" (ESM only)`);
  if (!pkg.main) fail(`package.json: main is required`);
  if (!pkg.exports) fail(`package.json: exports is required`);
  if (!Array.isArray(pkg["oc-plugin"]) || pkg["oc-plugin"].length === 0) {
    fail(
      `package.json: "oc-plugin" must be a non-empty target array (e.g. ["server", "tui"]) so OpenCode >= 1.3.4 can load the plugin`,
    );
  }
  if (!pkg.files || !pkg.files.includes("src") || !pkg.files.includes("commands")) {
    fail(`package.json: files must include "src" and "commands"`);
  }
  if (!pkg.peerDependencies?.["@opencode-ai/plugin"]) {
    fail(`package.json: must declare @opencode-ai/plugin as a peerDependency`);
  }
}

function checkEntrypoint(): void {
  const entry = path.join(repoRoot, "src/index.ts");
  if (!fs.existsSync(entry)) {
    fail(`src/index.ts: missing`);
    return;
  }
  const body = fs.readFileSync(entry, "utf8");
  if (!/export default /.test(body)) fail(`src/index.ts: must default-export a Plugin factory`);
  if (!/from "@opencode-ai\/plugin"/.test(body)) fail(`src/index.ts: must import types from @opencode-ai/plugin`);
}

function checkCommands(): void {
  const dir = path.join(repoRoot, "commands");
  // sessions-rethink PR 4 — the seven /lib-session-* verbs are retired
  // and replaced by four user-facing commands. The validator now gates
  // on the new surface.
  const expected = ["handoff.md", "takeover.md", "learn.md", "toggle-private.md"];
  for (const file of expected) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      fail(`commands/${file}: missing — the four user-facing verbs are the contract`);
      continue;
    }
    const body = fs.readFileSync(p, "utf8");
    if (!/^---\n[\s\S]*?description:[\s\S]*?\n---/.test(body)) {
      fail(`commands/${file}: must start with YAML frontmatter including a description: field`);
    }
    if (/\.\.\/\.\.\//.test(body)) {
      fail(
        `commands/${file}: contains relative paths (../../) — they won't resolve from inside node_modules; use absolute URLs`,
      );
    }
  }
}

// Note: an earlier version of this validator gated byte-identity
// between `src/privacy-detector.ts` and a canonical TS source at
// `the-librarian/integrations/shared/librarian-lifecycle/src/privacy.ts`.
// That canonical source was deleted when the Librarian family went
// fully standalone, so the byte-identity check was dropped. The
// privacy-marker list now lives as five peer implementations across
// the family; coordinate any change via the AGENTS.md §2 rule, not
// via a local validator.

checkPackageJson();
checkEntrypoint();
checkCommands();

if (errors.length === 0) {
  console.log("OK");
  process.exit(0);
}
console.error(`${errors.length} validation error${errors.length === 1 ? "" : "s"}:`);
for (const e of errors) console.error(`  - ${e}`);
process.exit(1);
