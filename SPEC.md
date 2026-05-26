# Spec: the-librarian-opencode-plugin

An [opencode](https://opencode.ai) plugin for The Librarian — durable
memory + cross-harness session lifecycle, backed by the remote Librarian
MCP server. Sibling to
[`the-librarian-claude-plugin`](https://github.com/JimJafar/the-librarian-claude-plugin),
[`the-librarian-codex-plugin`](https://github.com/JimJafar/the-librarian-codex-plugin),
[`the-librarian-hermes-plugin`](https://github.com/JimJafar/the-librarian-hermes-plugin),
and [`the-librarian-pi-extension`](https://github.com/JimJafar/the-librarian-pi-extension).

Status: **draft, awaiting human approval** before Phase 2 (Plan).

## Objective

Give opencode the same Librarian feature surface the other four plugins
give their harnesses:

- the Librarian **memory + session MCP tools** (`recall`, `remember`,
  `verify_memory`, `start_session`, `checkpoint_session`, …) over the
  user's remote endpoint, via opencode's native `mcpServers` config;
- the seven canonical **`/lib-session-*` slash commands**, written by
  the plugin to `~/.config/opencode/commands/` on first
  `session.created`. Empirical Task-0 investigation confirmed
  opencode does NOT auto-discover commands from inside an installed
  plugin's `node_modules/` directory — the source's `Command.Service`
  only reads from `cfg.command`, MCP prompts, and the `Skill.Service`
  (which scans `.claude/`, `.agents/`, `.opencode/`, and configured
  paths but not `node_modules/`). See
  [`notes/commands-discovery.md`](./notes/commands-discovery.md) for
  the full investigation. The plugin's `commands/` directory in the
  npm package is the **source** for the runtime write; an idempotent
  sentinel file prevents re-write churn;
- **automatic session lifecycle** via opencode's session events — start
  on `session.created`, checkpoint on `session.compacted`, per-turn
  record on `session.idle`, debounced second-tier checkpoint on the same
  policy as the Codex plugin (≥ 10 min OR ≥ 20 turns), reconcile stale
  active sessions on next `session.created` for the same `source_ref`;
- an **off-record privacy gate** detecting natural-language markers in
  user messages and ending the attached session within the same turn
  (per Q1: the marker turn itself is recorded because opencode's
  documented hooks fire after the model sees the prompt — documented as
  a known limitation vs Codex/Claude/Hermes);
- **distribution as an npm package** installable via opencode's native
  `plugin: [...]` config; local file-drop into `.opencode/plugins/`
  remains available for development.

### Non-goals

- We do not ship a local Librarian server — this is a **remote-MCP-only**
  plugin (same posture as the other four).
- We do not register MCP servers programmatically — opencode has no
  documented plugin API for that. Users add the `mcpServers.librarian`
  block to their `opencode.json` themselves; the plugin's README
  documents the snippet.
- We do not write to the user's `opencode.json`. The plugin reads from
  it; it never mutates it.
- We do not synthesise a separate `wrapper.sh` — opencode's in-process
  plugin runtime makes the lifecycle-bracketing wrapper obsolete. The
  existing in-tree `integrations/opencode/wrapper.sh` will be retired
  when this plugin lands (separate PR against the main repo,
  symmetric with how Codex/Pi were graduated).

## Tech stack

- **opencode plugin spec** (May 2026): npm-installable plugin, loaded by
  opencode at startup. Local file alternative: `.opencode/plugins/*.ts`
  (project) or `~/.config/opencode/plugins/*.ts` (global).
- **Runtime:** [Bun](https://bun.sh) (opencode's runtime). TypeScript
  native — no pre-compile step needed for the runtime entry. The package
  ships TS source as the published entry point.
- **Plugin shape:** an async factory returning a `Plugin` object — a map
  of hook names to async handlers. Types from `@opencode-ai/plugin`
  (peer dep on whatever opencode version the user is on).
- **MCP transport:** HTTP, via opencode's native `mcpServers` config in
  the user's `opencode.json`. The plugin uses its own thin HTTP MCP
  client for the *automatic* recording calls (so off-record and
  fail-soft can be enforced locally without going through opencode's
  MCP layer).
- **Privacy detector:** **direct port from the canonical TypeScript
  source** in
  [`the-librarian/integrations/shared/librarian-lifecycle/src/privacy.ts`](https://github.com/JimJafar/the-librarian/blob/main/integrations/shared/librarian-lifecycle/src/privacy.ts).
  Same Bun/TS runtime, so this is a copy of the canonical source rather
  than a port — one less drift surface than Codex (JS port) or Hermes
  (Python port). Documented in the plugin's AGENTS.md §2.

## Commands

```sh
# Install runtime deps (peer dep on @opencode-ai/plugin will be hoisted
# by the user's opencode install; bun install picks up the dev deps).
bun install

# Type-check (no compilation needed for runtime; this gates published
# types).
bun run typecheck

# Unit tests via Bun's built-in test runner.
bun test

# End-to-end smoke against a mock Librarian + a simulated opencode
# plugin runtime (drives the real exported Plugin against synthetic
# session events).
bun run smoke

# Validate the package shape (package.json fields, the exported Plugin
# matches the type, no committed dist/ drift if we end up needing one).
bun run validate

# Local install (for hand-testing in opencode):
bun link               # in the plugin repo
cd /path/to/project
bun link the-librarian-opencode-plugin
# then add to opencode.json: "plugin": ["the-librarian-opencode-plugin"]
```

No `dev` script — the plugin runs inside opencode; the iteration loop is
edit-TS → re-launch opencode → test.

## Project structure

```
the-librarian-opencode-plugin/
├── package.json                     # name, exports, peer dep @opencode-ai/plugin
├── tsconfig.json                    # strict; emits types only (no JS dist needed)
├── src/
│   ├── index.ts                     # Plugin factory — registers all hooks
│   ├── handlers/
│   │   ├── session-created.ts       # ensure-commands + bootstrap + reconcile stale active
│   │   ├── ensure-commands.ts       # write commands/*.md → ~/.config/opencode/commands/ idempotently
│   │   ├── message-updated.ts       # off-record gate (Q1: post-model lag accepted)
│   │   ├── session-compacted.ts     # checkpoint_session
│   │   ├── session-idle.ts          # per-turn record + debounced checkpoint
│   │   └── session-deleted.ts       # pause/end on user-deleted opencode session
│   ├── privacy-detector.ts          # canonical port of the-librarian/.../privacy.ts
│   ├── mcp-client.ts                # HTTP MCP client (same security posture as Codex)
│   ├── mcp-parse.ts                 # ID/status/list extractors
│   ├── source-ref.ts                # opencode:run:{id}:cwd:{abs}
│   ├── state-store.ts               # atomic writes + withLock — same shape as Codex
│   ├── checkpoint-policy.ts         # shouldCheckpoint(state, now) — same constants
│   └── log.ts                       # append-only with 5 MiB rotation
├── commands/                        # SOURCE files for the runtime install
│   ├── lib-session-start.md         #   (ensure-commands handler writes these
│   ├── lib-session-list.md          #    to ~/.config/opencode/commands/ on
│   ├── lib-session-resume.md        #    first session.created — sentinel
│   ├── lib-session-checkpoint.md    #    prevents re-write churn; see
│   ├── lib-session-pause.md         #    notes/commands-discovery.md for why
│   ├── lib-session-end.md           #    runtime write rather than
│   └── lib-session-search.md        #    auto-discovery)
├── tests/
│   ├── privacy-detector.test.ts     # 13-case matrix mirroring canonical TS + Hermes + Codex
│   ├── source-ref.test.ts
│   ├── state-store.test.ts          # atomic + lock + cross-process
│   ├── mcp-client.test.ts           # bearer, redirect:error, query-string reject, etc.
│   ├── checkpoint-policy.test.ts    # OR-of-conditions
│   ├── session-created.test.ts      # bootstrap + reconciliation
│   ├── message-updated.test.ts      # off-record gate (with the documented one-turn lag)
│   ├── session-compacted.test.ts    # checkpoint on compaction
│   ├── session-idle.test.ts         # per-turn record + debounced checkpoint
│   └── ensure-commands.test.ts      # idempotent install + sentinel + missing-file replace
├── scripts/
│   ├── smoke.ts                     # mock Librarian + drive synthetic events end-to-end
│   └── validate.ts                  # package.json + exports + commands/ shape
├── .github/workflows/ci.yml         # test/typecheck/validate/smoke on Bun matrix
├── AGENTS.md                        # family baseline + opencode-specific section
├── CHANGELOG.md                     # Keep-a-Changelog, baselined at v0.1.0
├── README.md                        # install (one-liner + opencode.json snippet) + envs + features + troubleshooting
├── LICENSE                          # Apache-2.0
├── .gitignore                       # node_modules, *.log, state.json/log.jsonl artefacts, dist/
└── SPEC.md / PLAN.md                # this file + the implementation plan
```

## Code style

Match the canonical TS source in `the-librarian` (since we're a direct
port for the privacy detector and a sibling design for the rest):
strict TypeScript, ESM, dependency-injected state for testability,
small focused files with a top-of-file comment explaining purpose and
upstream contract.

```ts
// src/handlers/session-created.ts
// Fires when opencode opens a new session — fresh project, restart,
// or explicit user action. Bootstraps a Librarian session if none is
// attached on this source_ref, then reconciles any stale `active`
// sessions on that ref (paused them — opencode has no analogue of
// SessionStart(source=resume), so reconciliation happens on every
// session.created where state.session_id is null or unresolvable).

import type { Plugin } from "@opencode-ai/plugin";
import { bootstrapSession } from "./session-bootstrap";
import { reconcileStaleActive } from "./reconcile";

export const onSessionCreated: NonNullable<Plugin["session.created"]> =
  async (input, _output, ctx) => {
    await reconcileStaleActive(ctx);
    await bootstrapSession(input, ctx);
  };
```

## Testing strategy

- **Framework:** Bun's built-in test runner (`bun test`) — zero deps,
  matches the runtime exactly.
- **Test locations:** `tests/*.test.ts`, one file per unit under test.
- **Coverage expectations:**
  - 100% line coverage on **privacy detector** (parity gate with
    canonical TS, Hermes Python port, Codex JS port).
  - 100% line coverage on **source_ref builder**.
  - All four lifecycle hooks have integration tests using a mock
    Librarian client + a tmp `state.json`.
- **Levels:**
  - **Unit:** privacy detector, source-ref, state-store, mcp-client,
    checkpoint-policy.
  - **Integration:** each handler with injected mocks (mock MCP
    client, tmp state-store, fake clock).
  - **Smoke:** `bun run smoke` boots an in-script mock Librarian HTTP
    server, instantiates the real exported Plugin, and drives the
    synthetic events that opencode would fire (`session.created`,
    `message.updated` with a non-marker prompt, `session.idle`,
    `message.updated` with an off-record marker, `session.compacted`,
    a second `session.created` with stale active to reconcile).

## Boundaries

**Always:**
- Honour the AGENTS.md §2 invariants — privacy beats convenience,
  fail-soft never blocks, the `/lib:session` verbs are sacred,
  three-state models, source_ref shape, CHANGELOG with every
  user-visible change, etc.
- TypeScript strict mode; no `any`.
- Direct port (not re-port) of the canonical privacy detector from
  `the-librarian/integrations/shared/librarian-lifecycle/src/privacy.ts`.
- 100% test coverage on privacy + source-ref.

**Ask first:**
- Adding a new event handler beyond the documented set (Q1 covers the
  privacy-gate lag — anything more elaborate is a separate decision).
- Any change to the canonical `/lib:session <verb>` contract — needs
  a coordinated change on `the-librarian/docs/slash-commands.md`.
- Mutating the user's `opencode.json` (we should never).
- Writing files outside `.opencode/commands/` or `${data dir}/`
  (especially anywhere under user-managed source).

**Never:**
- Bypass the privacy gate.
- Log bearer tokens.
- Mutate the user's `opencode.json` or any file outside the documented
  data dir / commands dir.
- Force-push to `main`.
- Block an opencode turn — every hook returns cleanly or throws to
  opencode's documented behaviour (which for non-blocking hooks is a
  silent log; for blocking hooks like `tool.execute.before` is the
  documented "throw to block" semantics, which we deliberately do not
  use).

## Success criteria

1. `bun add the-librarian-opencode-plugin` plus a one-liner addition to
   `opencode.json` (`"plugin": ["the-librarian-opencode-plugin"]` and
   `mcpServers.librarian`) and a single env var
   (`LIBRARIAN_AGENT_TOKEN`) is the entire install. README shows it.
2. On the first `session.created` after install, the plugin writes
   the seven `lib-session-*.md` files to
   `~/.config/opencode/commands/` (global, one-time per user). A
   sentinel `.librarian-installed` file containing the plugin version
   prevents re-write churn on subsequent runs; if a tracked file is
   missing from disk, only that one gets re-written. The user can
   edit any file freely — we don't overwrite edits, we only re-write
   missing files.
3. On `session.created`, a Librarian session is auto-started with
   `source_ref = opencode:run:<id>:cwd:<abs>` (or `cwd:<abs>`
   fallback) and any stale active sessions on the same source_ref are
   paused.
4. On `session.compacted`, `checkpoint_session` is called with an
   updated rolling summary.
5. On `session.idle`, a per-turn `record_session_event` with
   `type: "message"` is emitted (debounced policy: checkpoint on ≥ 10
   min OR ≥ 20 turns since last).
6. When a user message contains an off-record marker, the attached
   session ends within the same turn (the marker turn itself is
   recorded — documented limitation per Q1). Subsequent turns produce
   no recording until a back-on-record marker is detected.
7. `/lib-session-*` commands work as documented in the canonical
   contract.
8. All hook handlers complete in < 200 ms p50 on a local mock; fail
   soft on Librarian timeouts (15 s default).
9. Unit + integration + smoke + validate all green. CI matrix on
   current Bun.
10. `the-librarian/integrations/opencode/` and `.github/workflows/`
    integration-wrappers matrix entry can be deleted in a coordinated
    follow-up PR on the main repo (matching the Codex/Pi
    graduation).

## Open questions

(Resolved in Plan; listed here for traceability.)

- **Plugin commands discovery convention.** **Resolved by Plan Task 0
  on 2026-05-26.** Empirically + via opencode source inspection:
  there is no auto-discovery from inside the plugin's npm package.
  The plugin must write markdown files to one of opencode's scanned
  locations at runtime. Decision: write to
  `~/.config/opencode/commands/` (global, one-time per user) on first
  `session.created` with an idempotent sentinel. See
  [`notes/commands-discovery.md`](./notes/commands-discovery.md).
- **Cross-process safety of the state-store on Bun.** Same `O_EXCL`
  pattern as the Codex Node version should work, but Bun's `fs`
  semantics differ in edge cases. Plan specifies a quick verification
  test.
- **`bun test` vs migrating to a third-party runner.** Bun's runner
  is fine for our needs and zero-config; lean Bun-native unless we
  hit a wall.

## Cross-references

- Canonical verb contract:
  [`the-librarian/docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md).
- Canonical privacy detector source (direct port):
  [`the-librarian/integrations/shared/librarian-lifecycle/src/privacy.ts`](https://github.com/JimJafar/the-librarian/blob/main/integrations/shared/librarian-lifecycle/src/privacy.ts).
- Architectural siblings:
  [the-librarian-codex-plugin](https://github.com/JimJafar/the-librarian-codex-plugin)
  (closest in shape — same hook-driven lifecycle, same fail-soft
  posture, same state-store + checkpoint-policy patterns).
- Existing in-tree integration (to be retired in a follow-up):
  [`the-librarian/integrations/opencode/`](https://github.com/JimJafar/the-librarian/tree/main/integrations/opencode).
- opencode plugin docs: <https://opencode.ai/docs/plugins/>.
