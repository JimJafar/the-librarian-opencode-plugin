# Implementation Plan: the-librarian-opencode-plugin

Companion to [`SPEC.md`](./SPEC.md). Status: **draft, awaiting human
approval** before Phase 3 (Tasks → Implement).

## Overview

Ship the fifth and final Librarian plugin — opencode parity with the
Claude, Codex, Hermes, and Pi plugins: remote Librarian MCP via
opencode's native `mcpServers`, seven `/lib-session-*` slash commands
shipped inside the plugin package, automatic session lifecycle via
opencode's session events, an off-record privacy gate (with the
documented one-turn lag per Q1), and a follow-up PR against the main
repo to retire the in-tree `integrations/opencode/` copyable package.

## Architecture decisions

| Decision | Rationale |
|---|---|
| **Plugin writes `commands/*.md` to `~/.config/opencode/commands/` at runtime** | **Task 0 finding (2026-05-26):** opencode does NOT auto-discover commands from inside an installed plugin's npm package. The source's `Command.Service` reads from `cfg.command`, MCP prompts, and `Skill.Service` only; `Skill.Service` scans `.claude/`, `.agents/`, `.opencode/`, configured paths, and remote URLs — never `node_modules/`. Per anomalyco/opencode#5305 ("Plugins can only create slash commands (via command markdown files)") the existing pattern IS runtime write. See `notes/commands-discovery.md`. |
| **One TS module per hook, dispatched from `src/index.ts`** | Mirrors the Codex plugin's `src/handlers/` layout (one file per event), keeping the handlers small + independently testable. The exported `Plugin` is just the wiring. |
| **MCP server registered in user's `opencode.json`** (manual snippet, not plugin-mutated) | opencode has no programmatic API for that, and we never mutate user config. README shows the four-line snippet. |
| **Direct port (not re-port) of the canonical TS privacy detector** | Bun runs the same TS the canonical source is written in. No drift surface — just a `cp` from the upstream file, with the import path adjusted. |
| **Atomic state-store + withLock, same shape as Codex** | Resolves any cross-process race the same way (opencode's plugin process model is in-process so the race is rarer than Codex's, but worth keeping the invariant). Cross-process safety on Bun's `fs.openSync('wx')` verified in Task 4. |
| **Privacy gate at `message.updated` with documented one-turn lag** | Per Q1: opencode's documented hook surface fires after the model sees the prompt. The marker turn IS recorded; subsequent turns until back-on-record are not. Documented as a known limitation in README + CHANGELOG. |
| **No `wrapper.sh`** | opencode's in-process plugin runtime makes a CLI bracket script obsolete. Existing in-tree `wrapper.sh` is retired in the follow-up PR on the main repo. |
| **No bundle commitment** | Bun runs TS natively; we ship source. `dist/` is gitignored, generated only for type emit (`.d.ts`) if needed. This is **simpler than Codex** because Bun is the runtime, not a compatibility target. |

## Open questions — resolved

### Q1. Privacy-gate timing (post-model lag)

**Resolved per user direction in spec discussion: accept the lag, gate at `message.updated`.** The marker turn IS recorded; subsequent turns are not. Documented as a known limitation in README's "What it does" section and in CHANGELOG known-limitations.

### Q2. Commands install path

**Resolved by Task 0 finding:** there is no auto-discovery from inside the plugin's npm package. The plugin writes `commands/*.md` to `~/.config/opencode/commands/` (global, one-time per user) on first `session.created`. Sentinel `.librarian-installed` prevents re-write churn; missing files get re-written; user edits are never clobbered.

### Q3. Plugin commands discovery convention

**Resolved on 2026-05-26 in Task 0.** Empirical probe (local-file plugin with marker `.md` at four candidate locations) plus opencode source-code inspection (`packages/opencode/src/command/index.ts` + `packages/opencode/src/skill/index.ts` on the anomalyco/opencode main branch). Conclusion: opencode loads commands only from `cfg.command`, MCP prompts, and SKILL.md files in canonical locations — never `node_modules/`. The plugin's npm package `commands/` directory is the **source** for the runtime install; not auto-discovered. Full investigation in `notes/commands-discovery.md`.

### Q4. Cross-process safety of `withLock` on Bun

**Resolved in Plan Task 4.** Same `fs.openSync(lockPath, 'wx')` pattern as the Codex Node version. Bun supports `fs` mostly the same way; Task 4 includes a two-process test (spawn two `bun` subprocesses contending for the same lock and assert exactly one critical section runs at a time). If it fails, we swap to Bun's `flock`-equivalent and document.

### Q5. `bun test` vs Vitest

**Decision: `bun test`.** Zero-config, ships with Bun, no extra dependency. Migrate if we hit a feature wall (none expected for our pattern of pure-logic + dependency-injected tests).

### Q6. Source_ref shape

**Decision: switch to family-standard `opencode:run:<id>:cwd:<abs>`.** The existing in-tree wrapper uses `opencode:project:{cwd}:session:{id}` (predates the spec). Aligning with the AGENTS.md §4 invariant is a one-time break — flagged in the follow-up PR's CHANGELOG migration note (users with old sessions on that source_ref shape will see them as separate from new sessions; they can resume the old ones explicitly by id).

## Dependency graph

```
Task 0: Verify commands discovery convention      [risk-front-load]
   │
Task 1: Package skeleton (package.json + tsconfig + src/index.ts)
   │
   ├── Task 2: Bun build/test/typecheck wired (no handlers yet)
   │       │
   │       └── Task 3: Privacy detector (direct port from canonical TS)
   │
   ├── Task 4: state-store + withLock + cross-process verification
   │       │
   │       └── Task 5: mcp-client + mcp-parse (lift from Codex, adapt for Bun)
   │               │
   │               ├── Task 6: source-ref + session-bootstrap
   │               │       │
   │               │       └── Task 7: session.created handler (bootstrap + reconcile)
   │               │
   │               ├── Task 8: message.updated handler (off-record gate)
   │               │
   │               ├── Task 9: session.compacted handler (checkpoint)
   │               │
   │               └── Task 10: session.idle handler (per-turn + debounced checkpoint)
   │
   ├── Task 11: commands/*.md (lift the 7 from integrations/opencode/commands/, update paths)
   │
   ├── Task 12: AGENTS.md (family baseline + opencode-specific gotchas)
   │
   ├── Task 13: validate.ts + smoke.ts
   │
   └── Task 14: README + CHANGELOG (Keep-a-Changelog, baselined at v0.1.0) + LICENSE
           │
           └── Task 15: Publish — push, PR, watch CI, merge, tag v0.1.0
                   │
                   └── Task 16 (follow-up on main repo): retire integrations/opencode/
```

Vertical slices: **Task 0 is the loader-verification gate.** Tasks 1–3 are foundation; Tasks 4–10 are the lifecycle layered on; Tasks 11–14 are docs + release-readiness; Tasks 15–16 ship and clean up.

## Task list

### Phase 1: Foundation + risk-front-loading

#### Task 0: Verify opencode's plugin-commands discovery convention

**Description:** Per anomalyco/opencode#5305, plugins can ship slash commands via markdown files, but the public docs don't specify the location inside a plugin package. Build a throwaway hello-world plugin that places marker files in each plausible location (`commands/lib-hello-pkg.md`, `.opencode/commands/lib-hello-dot.md`, plus a `package.json` `opencode.commands` field pointing at a third location). `bun link` it into a test project, launch opencode, observe which markers appear as slash commands. Document the finding.

**Acceptance:**
- `notes/commands-discovery.md` in the repo records the verified location with one full real example.
- A regression flag for Task 11: if opencode doesn't auto-load any of the locations, we add a runtime auto-install handler BEFORE Task 11; if it does, we ship `commands/*.md` at the documented location.

**Verification:**
- Hello-world install + opencode launch + slash-menu inspection. Recorded as a one-shot screenshot or copy-paste of the observed menu.

**Files touched:** `notes/commands-discovery.md` (new). Throwaway hello-world plugin lives in a temp dir, not committed.

**Scope:** S. Risk-front-loaded. **If this fails (no native discovery), the whole spec changes shape.**

#### Task 1: Package skeleton

**Description:** Minimal installable package. `package.json` with `name`, `version: 0.1.0`, `type: "module"`, `main: "./src/index.ts"`, `exports`, `peerDependencies: { "@opencode-ai/plugin": "*" }`, `devDependencies: { "@opencode-ai/plugin": "<latest>", "@types/bun": "<latest>" }`. `tsconfig.json` strict, ESM, `noEmit: true` (until we need a `dist/`). `src/index.ts` exports an empty `Plugin` object (no hooks wired yet).

**Acceptance:**
- `bun install` succeeds.
- `bun run typecheck` exits 0.
- `bun test` exits 0 (no tests yet).
- The exported `Plugin` satisfies `Plugin` from `@opencode-ai/plugin` (type-only check).

**Verification:** `bun link` into a fresh test project, add to `opencode.json`'s `plugin` array, launch opencode, confirm no errors. Slash commands from Task 0 (if `commands/` is wired) should also surface.

**Files touched:** `package.json`, `tsconfig.json`, `src/index.ts`, `.gitignore`.

**Scope:** S.

#### Task 2: Bun build/test/typecheck wired

**Description:** Add scripts to `package.json` (`typecheck`, `test`, `build` (placeholder), `validate`, `smoke`). Add the first test fixture so `bun test` is exercising the runner. Add `.github/workflows/ci.yml` matrix on current Bun.

**Acceptance:**
- `bun run typecheck && bun test && bun run validate` all exit 0.
- CI matrix runs on at least Bun 1.x latest.

**Files touched:** `package.json` (scripts), `tests/setup.test.ts` (trivial test that imports `src/index.ts`), `.github/workflows/ci.yml`, `scripts/validate.ts` (stub).

**Scope:** S.

### Phase 2: Pure logic (no opencode runtime needed)

#### Task 3: Privacy detector (direct port)

**Description:** `cp` `the-librarian/integrations/shared/librarian-lifecycle/src/privacy.ts` into `src/privacy-detector.ts`, adjust the import path / module style if needed. The 13-case test matrix ports verbatim from `the-librarian/integrations/shared/librarian-lifecycle/tests/privacy.test.ts` — same fixtures, same assertions.

**Acceptance:**
- `src/privacy-detector.ts` byte-identical to the canonical source except for the file-header comment and any import-path adjustment.
- 13/13 tests pass.
- 100% line coverage.

**Verification:** `bun test tests/privacy-detector.test.ts`. Compare with canonical source via `diff`.

**Files touched:** `src/privacy-detector.ts`, `tests/privacy-detector.test.ts`.

**Scope:** S.

#### Task 4: state-store + withLock + cross-process verification

**Description:** Lift the Codex plugin's `src/state-store.mjs` shape (atomic `writeFile → rename`, `O_EXCL` lockfile with stale-steal). Port to TS. **Add a cross-process test** that spawns two `bun` subprocesses contending for the same lock and asserts exactly one critical section ran (matches the empirical verification I did manually on Codex).

**Acceptance:**
- Same API as Codex: `DEFAULT_STATE`, `loadState`, `saveState`, `withLock`.
- 20-concurrent saves don't corrupt the file (in-process test).
- 5-concurrent `withLock` critical sections never overlap (in-process test).
- **Two-process** lock contention test passes (spawn `bun run scripts/lock-contender.ts` twice, assert exactly one acquires).
- If the two-process test fails on Bun, swap to an `flock`-equivalent or document the failure mode before continuing.

**Files touched:** `src/state-store.ts`, `tests/state-store.test.ts`, `scripts/lock-contender.ts` (helper for the two-process test).

**Scope:** M.

#### Task 5: mcp-client + mcp-parse

**Description:** Lift `src/mcp-client.mjs` and `src/mcp-parse.mjs` from the Codex plugin, port to TS. Same security posture (redirect: error, embedded-credentials reject, query-string reject, response size cap, timeout). Dependency-inject the transport for testability.

**Acceptance:**
- 6+ tests covering: bearer header set; non-200 throws http-kind error; JSON-RPC error throws rpc-kind; non-JSON throws malformed; non-http(s) endpoint rejected; embedded credentials rejected; query string rejected.
- `parseSessionId`, `parseSessionList` regexes accept the realistic Librarian ID shape (`ses_<UUID>` with hyphens, also underscores — defensive).

**Files touched:** `src/mcp-client.ts`, `src/mcp-parse.ts`, `tests/mcp-client.test.ts`.

**Scope:** M.

### Phase 3: Lifecycle handlers

#### Task 6: source-ref + session-bootstrap

**Description:** `src/source-ref.ts` building `opencode:run:<id>:cwd:<abs>` from opencode's session id (available in `ctx`) plus the project cwd, with `cwd:<abs>` fallback. `src/handlers/session-bootstrap.ts` is the shared idempotent bootstrap (same shape as Codex's): under lock, read state, if no session_id and not private, call `start_session` and persist; on race, the loser observes session_id and bails.

**Acceptance:**
- 100% line coverage on source-ref.
- Race test: 5 concurrent bootstraps produce exactly one `start_session` call.

**Files touched:** `src/source-ref.ts`, `src/handlers/session-bootstrap.ts`, `tests/source-ref.test.ts`, `tests/session-bootstrap.test.ts`.

**Scope:** M.

#### Task 7: `session.created` handler — ensure-commands + bootstrap + reconciliation

**Description:** On `session.created`, run in order: (a) `ensure-commands` (idempotent install of the seven `lib-session-*.md` files from the package's `commands/` dir into `~/.config/opencode/commands/`, with a sentinel file `.librarian-installed` containing the plugin version), (b) bootstrap (under lock — start a Librarian session if none attached + not private), (c) reconcile any active sessions on this `source_ref` that aren't ours by pausing them. Same RACE GUARD fix as the Codex post-review pass.

The `ensure-commands` step lives in its own module (`src/handlers/ensure-commands.ts`) for testability and clean separation of concerns; the session-created handler just calls it first.

**Acceptance:**
- 8+ integration tests for bootstrap+reconcile (fresh start, already-attached no-op, off-record skip, fail-soft on server error / no client / malformed response, multi-stale reconcile, RACE GUARD).
- 5+ tests for ensure-commands (fresh install writes all 7 + sentinel; sentinel matches → no writes; missing file → only missing file rewritten; user-edited file → never overwritten; sentinel version mismatch → all files re-written, edits preserved by per-file checksum).

**Files touched:** `src/handlers/session-created.ts`, `src/handlers/ensure-commands.ts`, `tests/session-created.test.ts`, `tests/ensure-commands.test.ts`.

**Scope:** M.

#### Task 8: `message.updated` handler — off-record gate

**Description:** When the event payload contains a user message, run the privacy detector on its text. On `enter-private` / `toggle-to-private`, end any attached session with reason "switching to private mode" and flip `state.private`. On `exit-private` / `toggle-to-public`, flip back. Always return cleanly — never throw (opencode would treat a throw as a block, which we don't want for non-tool events anyway).

**Document the one-turn lag** in both the handler's top-of-file comment and the README.

**Acceptance:**
- 7+ tests mirroring the Codex `user-prompt-submit` suite, adapted: non-marker no-op, enter-private with session ends it, enter-private with no session is a clean flip, exit-private flips back without recording, toggle public→private, end_session failure during enter-private is fail-soft.
- README's "What it does" section explicitly documents the one-turn lag.

**Files touched:** `src/handlers/message-updated.ts`, `tests/message-updated.test.ts`.

**Scope:** M.

#### Task 9: `session.compacted` handler — checkpoint

**Description:** On `session.compacted`, if attached + not private, call `checkpoint_session` with a summary distinguishing manual vs auto compaction (if the payload distinguishes — otherwise generic). Reset debounce counters.

**Acceptance:**
- 5 tests: happy path + counter reset, off-record skip, no-session skip, no-client skip, fail-soft on server error.

**Files touched:** `src/handlers/session-compacted.ts`, `tests/session-compacted.test.ts`.

**Scope:** S.

#### Task 10: `session.idle` handler — per-turn record + debounced checkpoint

**Description:** On `session.idle`, if attached + not private, call `record_session_event({type: "message", summary})` derived from the last assistant message (capped at 280 chars). Increment turn counter. Apply the debounced checkpoint policy (≥ 10 min OR ≥ 20 turns since last) — same constants as Codex in `src/checkpoint-policy.ts`.

**Acceptance:**
- 9+ tests: record happy path, summary truncation, tool-only turn placeholder, turns-threshold checkpoint, interval-threshold checkpoint, off-record skip, no-session skip, record fail-soft skips checkpoint, checkpoint fail leaves counter incremented for retry.

**Files touched:** `src/handlers/session-idle.ts`, `src/checkpoint-policy.ts`, `tests/session-idle.test.ts`, `tests/checkpoint-policy.test.ts`.

**Scope:** M.

### Phase 4: Ship-readiness

#### Task 11: `commands/*.md` (seven files)

**Description:** Lift the seven markdown files from `the-librarian/integrations/opencode/commands/`, update the canonical-contract link to be an absolute URL to `the-librarian/docs/slash-commands.md` (relative paths won't resolve when loaded from inside `node_modules/`), and tweak any harness-specific text. Layout per Task 0's verified convention.

**Acceptance:**
- All seven commands present, frontmatter `description` correct, body references canonical contract.
- Empirical: `bun link`-installed in a test project, all seven appear in opencode's `/` autocomplete menu.

**Files touched:** `commands/lib-session-{start,list,resume,checkpoint,pause,end,search}.md`.

**Scope:** S.

#### Task 12: AGENTS.md (family baseline + opencode-specific gotchas)

**Description:** Adapt the family baseline (same as the four sibling plugin AGENTS.md files I just shipped). Per-repo "what this repo is" + build/test commands + opencode-specific gotchas:
- Bun runtime, TS native (no bundle to commit unlike Codex/Claude)
- Privacy gate has a one-turn lag (documented in code + README)
- Direct port (not re-port) of the canonical privacy detector — change all three (TS source + Hermes Python + Codex JS) only when changing this one
- Plugin commands discovery convention (whatever Task 0 verified)

**Acceptance:**
- ~140 lines total. House Rules section verbatim with siblings.

**Files touched:** `AGENTS.md`.

**Scope:** S.

#### Task 13: `validate.ts` + `smoke.ts`

**Description:** `validate.ts`: check `package.json` (name, version, exports, peer dep), the seven commands' frontmatter, the privacy detector matches the canonical source byte-for-byte modulo headers, and `src/index.ts` exports a `Plugin` that satisfies the type. `smoke.ts`: in-script mock Librarian HTTP server, instantiate the real exported Plugin, drive synthetic session events, assert the expected MCP calls happened.

**Acceptance:**
- Both exit 0 on a clean tree, non-zero with a clear error on a broken one (broken-state tested manually before commit).
- Smoke covers each of the four handlers (`session.created`, `message.updated`, `session.compacted`, `session.idle`) + the RACE GUARD path.

**Files touched:** `scripts/validate.ts`, `scripts/smoke.ts`, `package.json` (scripts wired).

**Scope:** M.

#### Task 14: README + CHANGELOG + LICENSE

**Description:** README mirrors the Codex plugin's structure (install, configure env vars, what it does, troubleshooting, develop). LICENSE Apache-2.0. CHANGELOG baselined at v0.1.0 per the family pattern + AGENTS.md §5 ("treat current version as first public adoption").

**Acceptance:**
- One-liner install in README is accurate against Task 0's verified discovery convention.
- "What it does" section documents the one-turn privacy lag explicitly.
- CHANGELOG `[Unreleased]` block ready for next change.

**Files touched:** `README.md`, `LICENSE`, `CHANGELOG.md`.

**Scope:** S.

#### Task 15: Publish

**Description:** Push to GitHub (repo already exists at `JimJafar/the-librarian-opencode-plugin`), open PR, watch CI, merge with `--rebase --delete-branch`, tag `v0.1.0`.

**Acceptance:**
- All CI green.
- v0.1.0 tag points at the merge commit.
- Manual: `bun add the-librarian-opencode-plugin@0.1.0` in a fresh opencode project + the one-line opencode.json edit + the env var = working slash commands and a session showing up on the dashboard.

**Files touched:** None code-side; publish + verify step.

**Scope:** S.

### Phase 5: Cross-repo cleanup

#### Task 16 (follow-up PR on `the-librarian`): retire `integrations/opencode/`

**Description:** Mirror the Codex/Pi graduation PRs (#160 + #161 on `the-librarian`). Delete `integrations/opencode/`, update `integrations/README.md` (no more copyable packages — all five harnesses are now standalone), update root `README.md`'s Harness integrations section + Features bullet, update `CONTRIBUTING.md`'s repo-layout comment, drop OpenCode from the `integrations.test.ts` shape tests, remove the `integrations-wrappers` CI matrix entry (now empty — delete the whole job). Check if `@librarian/lifecycle`'s `harness/claude-code.ts` and `bin/claude-code-hook.ts` are the only remaining harness adapter in the shared lib (probably) and update the lifecycle README accordingly. **Update `the-librarian/CHANGELOG.md`'s `[Unreleased]` in the same PR.**

**Acceptance:**
- `integrations/` contains only `README.md` + `shared/`.
- All tests green on `the-librarian` main.
- Integration-wrappers CI job gone (or matrix collapsed to empty → job deleted).

**Files touched (rough):** `the-librarian/integrations/opencode/` (deleted), `the-librarian/integrations/README.md`, `the-librarian/integrations/shared/librarian-lifecycle/README.md`, `the-librarian/README.md`, `the-librarian/CONTRIBUTING.md`, `the-librarian/test/integrations.test.ts`, `the-librarian/.github/workflows/ci.yml`, `the-librarian/CHANGELOG.md`.

**Scope:** S.

## Risks and mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| opencode doesn't auto-load `commands/*.md` from the plugin package — only from `.opencode/commands/` | High | Medium | **Task 0 fails fast.** Verifies the convention with a hello-world plugin BEFORE we build anything else. If no native discovery works, we add a runtime auto-install handler in Task 11 and adjust the README's install section. |
| `withLock` doesn't work cross-process on Bun | Medium | Low | Task 4 includes a two-process test. If it fails, swap to a Bun-flavoured primitive or accept in-process-only safety (acceptable because opencode's plugin process is in-process — race is rarer than Codex's spawn-per-hook). |
| `message.updated` fires for ASSISTANT messages too and we false-positive | Medium | High | Filter on the payload's role/sender field. Test fixture covers both user and assistant messages, asserts the detector only runs on user. |
| `session.idle` fires too often and floods the Librarian | Low | Medium | Same 280-char cap + summary mode as Codex. Plus the debounced-checkpoint policy throttles the expensive call. Real-world load is what Codex already handles. |
| `@opencode-ai/plugin` type changes break us between versions | Medium | Medium | Peer dep on `*`, CI matrix tests against latest. If the type changes, we ship a minor version bump with a CHANGELOG migration note. |
| Existing in-tree users on `opencode:project:{cwd}:session:{id}` source_ref shape have their old sessions appear "different" after upgrade | Low | Low | One-time break flagged in the follow-up PR's CHANGELOG migration note. Users can resume old sessions explicitly by id. |
| Bun-specific test runner gaps vs Vitest | Low | Low | Migrate per-test if we hit a wall. None expected for our pattern. |

## Open questions (deferred to implementation)

- Plugin display metadata in `package.json` (description, keywords, repository) — copy from Codex plugin pattern in Task 14.
- Whether to publish to npm under `the-librarian-opencode-plugin` or `@librarian/opencode-plugin`. Unscoped is one-step (`bun add the-librarian-opencode-plugin`); scoped requires `@librarian` org. **Default: unscoped for v0.1.0**, can move to scoped later.
- Whether the package needs a `dist/` for non-Bun consumers. Bun is opencode's runtime, so probably not. Defer.

## Parallelization

Realistic single-session sequential pass is faster than coordinating parallel work. The dependency graph is deep (Task 0 gates everything; foundation gates Phase 3; Phase 3 handlers all share session-bootstrap from Task 6). No parallelism advantage.
