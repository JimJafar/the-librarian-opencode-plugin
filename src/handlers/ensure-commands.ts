// src/handlers/ensure-commands.ts
//
// Per Task 0 finding (notes/commands-discovery.md): opencode does NOT
// auto-discover slash commands from inside an installed plugin's npm
// package. To ship the seven `lib-session-*` verbs as slash commands
// we write the markdown files at runtime to one of opencode's scanned
// locations.
//
// Target: `~/.config/opencode/commands/` (user-global, one-time per
// user). Per-project would clutter every project the user opens with
// opencode.
//
// Idempotent: a sentinel `.librarian-installed` carrying the plugin
// version short-circuits re-writes. On version bump or sentinel
// absence, we walk the source `commands/` dir; for each file we ONLY
// write if the target doesn't already exist (so user edits are never
// clobbered). After the walk, the sentinel is updated.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Deps } from "../deps.ts";

const SENTINEL_FILENAME = ".librarian-installed";

export interface EnsureCommandsOptions {
  /** Where the plugin's source markdown files live. Defaults to ../../commands relative to this file. */
  sourceDir?: string;
  /** Where to install. Defaults to ~/.config/opencode/commands/. */
  targetDir?: string;
  /** The plugin version, stored in the sentinel. Defaults to reading ../../package.json. */
  pluginVersion?: string;
}

export interface EnsureCommandsResult {
  written: string[];
  skipped: string[];
  sentinel: "matched" | "wrote" | "skipped";
}

const defaultSourceDir = path.resolve(import.meta.dir, "../../commands");
const defaultTargetDir = path.join(os.homedir(), ".config", "opencode", "commands");

function defaultVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function ensureCommands(
  deps: Deps,
  opts: EnsureCommandsOptions = {},
): Promise<EnsureCommandsResult> {
  const sourceDir = opts.sourceDir ?? defaultSourceDir;
  const targetDir = opts.targetDir ?? defaultTargetDir;
  const version = opts.pluginVersion ?? defaultVersion();

  const result: EnsureCommandsResult = { written: [], skipped: [], sentinel: "skipped" };

  let sourceFiles: string[];
  try {
    sourceFiles = (await fs.promises.readdir(sourceDir)).filter((f) => f.endsWith(".md"));
  } catch (err) {
    const e = err as Error;
    await deps.log({ event: "ensure_commands", outcome: "source_dir_unreadable", source: sourceDir, error: String(e?.message ?? e) });
    return result;
  }

  if (sourceFiles.length === 0) {
    await deps.log({ event: "ensure_commands", outcome: "source_dir_empty", source: sourceDir });
    return result;
  }

  try {
    await fs.promises.mkdir(targetDir, { recursive: true });
  } catch (err) {
    const e = err as Error;
    await deps.log({ event: "ensure_commands", outcome: "target_dir_mkdir_failed", target: targetDir, error: String(e?.message ?? e) });
    return result;
  }

  // Sentinel short-circuit: if a sentinel matches the current version
  // exactly AND every source file already exists at the target, no
  // writes needed.
  const sentinelPath = path.join(targetDir, SENTINEL_FILENAME);
  const sentinelMatches = await readSentinel(sentinelPath) === version;
  if (sentinelMatches && (await allPresent(targetDir, sourceFiles))) {
    result.sentinel = "matched";
    return result;
  }

  // Walk each source file. If the target doesn't exist, write it. If
  // it exists, skip (user edits are sacred — they own their copy).
  for (const file of sourceFiles) {
    const targetPath = path.join(targetDir, file);
    const exists = await fileExists(targetPath);
    if (exists) {
      result.skipped.push(file);
      continue;
    }
    try {
      const body = await fs.promises.readFile(path.join(sourceDir, file), "utf8");
      await fs.promises.writeFile(targetPath, body, "utf8");
      result.written.push(file);
    } catch (err) {
      const e = err as Error;
      await deps.log({ event: "ensure_commands", outcome: "write_failed", file, error: String(e?.message ?? e) });
    }
  }

  // Update sentinel to current version (creates if missing).
  try {
    await fs.promises.writeFile(sentinelPath, version, "utf8");
    result.sentinel = "wrote";
  } catch (err) {
    const e = err as Error;
    await deps.log({ event: "ensure_commands", outcome: "sentinel_write_failed", error: String(e?.message ?? e) });
  }

  await deps.log({
    event: "ensure_commands",
    outcome: "done",
    written: result.written,
    skipped: result.skipped,
    sentinel: result.sentinel,
    target: targetDir,
    version,
  });
  return result;
}

async function readSentinel(p: string): Promise<string | null> {
  try {
    return (await fs.promises.readFile(p, "utf8")).trim();
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function allPresent(targetDir: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    if (!(await fileExists(path.join(targetDir, f)))) return false;
  }
  return true;
}
