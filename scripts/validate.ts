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
  const expected = [
    "lib-session-start.md",
    "lib-session-list.md",
    "lib-session-resume.md",
    "lib-session-checkpoint.md",
    "lib-session-pause.md",
    "lib-session-end.md",
    "lib-session-search.md",
  ];
  for (const file of expected) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      fail(`commands/${file}: missing — the seven /lib-session-* verbs are sacred (AGENTS.md §4)`);
      continue;
    }
    const body = fs.readFileSync(p, "utf8");
    if (!/^---\n[\s\S]*?description:[\s\S]*?\n---/.test(body)) {
      fail(`commands/${file}: must start with YAML frontmatter including a description: field`);
    }
    if (/\.\.\/\.\.\//.test(body)) {
      fail(`commands/${file}: contains relative paths (../../) — they won't resolve from inside node_modules; use absolute URLs`);
    }
  }
}

function checkPrivacyDetectorPortFidelity(): void {
  // The privacy detector MUST stay byte-identical (modulo the file
  // header) with the canonical TS source in the-librarian. If the
  // canonical source isn't available locally (CI / where the sibling
  // repo isn't checked out) we skip.
  const canonical = "/Users/jim/code/the-librarian/integrations/shared/librarian-lifecycle/src/privacy.ts";
  if (!fs.existsSync(canonical)) return;

  const ours = fs.readFileSync(path.join(repoRoot, "src/privacy-detector.ts"), "utf8");
  const stripped = ours.replace(/^[\s\S]*?(?=^\/\/ Privacy-marker detection)/m, "");
  const canonicalBody = fs.readFileSync(canonical, "utf8");

  if (stripped !== canonicalBody) {
    fail(
      `src/privacy-detector.ts: drift from canonical TS source. ` +
        `If this is intentional, change the canonical source in the same PR.`,
    );
  }
}

checkPackageJson();
checkEntrypoint();
checkCommands();
checkPrivacyDetectorPortFidelity();

if (errors.length === 0) {
  console.log("OK");
  process.exit(0);
}
console.error(`${errors.length} validation error${errors.length === 1 ? "" : "s"}:`);
for (const e of errors) console.error(`  - ${e}`);
process.exit(1);
