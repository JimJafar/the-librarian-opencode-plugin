#!/usr/bin/env bun
// scripts/lock-contender.ts
// Two-process lock-contention test helper. Acquires withLock on the
// dataDir from argv[2], holds for the holdMs from argv[3] (default 50
// ms), then releases. Logs `acquire <ms>` and `release <ms>` lines
// (epoch ms) to stdout so the parent test can verify non-overlap.

import { withLock } from "../src/state-store.ts";

const dataDir = process.argv[2];
const holdMs = Number(process.argv[3] ?? 50);

if (!dataDir) {
  console.error("usage: bun scripts/lock-contender.ts <dataDir> [holdMs]");
  process.exit(2);
}

await withLock(dataDir, async () => {
  console.log(`acquire ${Date.now()}`);
  await new Promise((r) => setTimeout(r, holdMs));
  console.log(`release ${Date.now()}`);
});
