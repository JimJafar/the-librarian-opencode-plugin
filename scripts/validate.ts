#!/usr/bin/env bun
// scripts/validate.ts
// Pre-commit / pre-tag shape check. Exits 0 with `OK` on success;
// exits 1 with a list of findings on failure. As the package grows
// this fills in: manifest shape, commands/ frontmatter, byte-identity
// between src/privacy-detector.ts and the canonical TS source,
// Plugin export satisfies the type.
//
// For Task 2 it just gates the package.json basics so we have a real
// CI step to evolve.

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

checkPackageJson();
checkEntrypoint();

if (errors.length === 0) {
  console.log("OK");
  process.exit(0);
}
console.error(`${errors.length} validation error${errors.length === 1 ? "" : "s"}:`);
for (const e of errors) console.error(`  - ${e}`);
process.exit(1);
