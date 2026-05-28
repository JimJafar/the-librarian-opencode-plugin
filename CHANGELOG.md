# Changelog

All notable changes to **the-librarian-opencode-plugin** are documented in
this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at v0.1.0 — the first version likely to see public
adoption. The pre-v0.1.0 development history lives in the git log; only
changes from this point forward are catalogued here.

## [Unreleased]

## [0.2.0] — 2026-05-28

### Added

- **Release runbook + per-repo release doc.** A new
  [`docs/release.md`](docs/release.md) captures the per-repo release
  steps (`package.json` bump, CHANGELOG move, tag, GitHub release,
  **then `npm publish` — this is the only plugin in the family with an
  npm artifact**). AGENTS.md is thinned and points at it; the
  cross-family runbook lives in the monorepo at
  [`the-librarian/docs/release-runbook.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/release-runbook.md).

### Changed

- **Sessions rethink — breaking change (sessions-rethink PR 4).** The
  entire session-lifecycle stack is retired in favour of a four-verb
  agent surface. The OpenCode plugin had the heaviest hook surface of
  any harness; this PR is correspondingly the largest deletion:
  - **Removed hooks:** `chat.message` (privacy gate), `event` switch
    on `session.created` / `session.idle` / `session.compacted`. Only
    `experimental.chat.system.transform` survives, and only to do
    conv-state injection (spec §4.9).
  - **Removed handlers:** `src/handlers/chat-message.ts`,
    `checkpoint-policy.ts`, `session-bootstrap.ts`,
    `session-compacted.ts`, `session-created.ts`, `session-idle.ts`.
  - **Removed source:** `src/state-store.ts`, `src/privacy-detector.ts`,
    `src/mcp-parse.ts`. The state-store file (with its per-cwd lock)
    and the natural-language private detector are gone — private mode
    is now an in-conversation `[librarian:private=on|off]` marker the
    LLM handles directly via `/toggle-private`.
  - **Removed commands:** the seven `commands/lib-session-*.md` files.
  - **Added commands:** `commands/handoff.md`, `takeover.md`,
    `learn.md`, `toggle-private.md` — installed via the existing
    `ensureCommands` mechanism at plugin init (instead of on
    `session.created`).
  - **Server compatibility:** requires a Librarian server running the
    sessions-rethink PR 1 build (the `store_handoff` / `list_handoffs`
    / `claim_handoff` and `conv_state_*` MCP tools must exist).
  - **Migration:** existing operators should restart opencode. The
    install dir is now resolved via `LIBRARIAN_COMMANDS_DIR` (override)
    then `$XDG_CONFIG_HOME/opencode/commands`, then
    `~/.config/opencode/commands`. The old `lib-session-*.md` files
    written by prior versions can be deleted by hand — the new build
    never touches them.

### Added

- **Conv-state injection via `experimental.chat.system.transform`.**
  Implements §4.9 of the upstream memory-domain-isolation rollout. A
  new handler fires once per turn after opencode assembles the system
  prompt, resolves the calling `conversation_state` row via
  `conv_state_get`, and `.push()`es the canonical
  `<conversation-state>` block onto `output.system`. The LLM sees the
  current `domain` / `session_id` / `off_record` on every turn,
  defeating context-compaction-driven state loss. Fail-soft per
  AGENTS.md §2 — off-record / missing sessionID / missing row /
  network failure / timeout / unexpected throw all leave
  `output.system` untouched.
- **`AGENTS.md` §5 — monitoring plan for the experimental hook.** Four
  mechanisms (pinned SDK + CI typecheck; CHANGELOG grep on bumps;
  namespace-graduation watch; quarterly eyeball re-test) so the
  `experimental.*` namespace can be tracked without surprise.

### Changed

- **Privacy detector documentation:** AGENTS.md §2 and §4 updated to
  reflect that the canonical TS source in `the-librarian` was deleted
  when the family went fully standalone. The privacy detector is now
  one of five peer implementations across the family (Claude Code,
  Codex, Hermes, this repo, Pi); coordinate any marker-list change
  across all five repos.
- **`scripts/validate.ts`:** removed the byte-identity check against
  the canonical TS source (the canonical no longer exists). All other
  shape checks (package.json, entrypoint, commands frontmatter) are
  unchanged.

## [0.1.0] — 2026-05-26

Initial public release. An [opencode](https://opencode.ai) plugin for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory
+ cross-harness session lifecycle, backed by a remote Librarian MCP server.

### Added

- **Plugin entry** (`src/index.ts`): registers two opencode hooks —
  `chat.message` (pre-LLM privacy gate) and the generic `event` hook
  (switched on `session.created` / `session.idle` /
  `session.compacted`).
- **`/lib-session-*` slash commands**: seven per-verb markdown files
  (start, list, resume, checkpoint, pause, end, search) shipped in
  the plugin's `commands/` directory. The `ensure-commands` handler
  installs them to `~/.config/opencode/commands/` on first
  `session.created`; sentinel `.librarian-installed` prevents
  re-write churn; user edits are never clobbered.
- **Automatic session lifecycle**: bootstrap on `session.created`
  (race-safe), per-turn `record_session_event` on `session.idle`,
  `checkpoint_session` on `session.compacted` and on a debounced
  threshold (≥ 10 min OR ≥ 20 turns), and stale-active
  reconciliation on every `session.created`.
- **Off-record privacy gate** via `chat.message` (pre-LLM, mutable
  output): natural-language markers (`off the record`, `keep this
  between us`, …) and `/lib-toggle-private` end the attached session
  within the SAME turn (no one-turn lag — unlike the Codex / Claude
  / Hermes plugins which fire post-prompt).
- **Direct port of the canonical TS privacy detector** from
  `the-librarian/integrations/shared/librarian-lifecycle/src/privacy.ts` —
  one fewer drift surface than the Codex JS port or the Hermes Python
  port. `scripts/validate.ts` gates byte-identity in dev.
- **Atomic state store + cross-process lock** (`O_EXCL` on the
  lockfile, stale-steal fallback). Cross-process safety on Bun
  verified empirically with a two-process contention test in CI.
- **Append-only log** at `${data dir}/log.jsonl` with 5 MiB rotation
  (one prior generation retained).
- **CI** at `.github/workflows/ci.yml` on Bun latest runs
  `typecheck + test + validate + smoke` per push and PR.

### Security posture

- HTTP MCP client rejects: non-http(s) endpoints, endpoints with
  embedded credentials, endpoints with query strings (would leak
  bearer in URL-capturing logs).
- `redirect: "error"` so a 3xx never carries the bearer header
  cross-origin.
- 8 MiB response body cap; 15 s default per-call timeout.
- Bearer token only ever sent in the `Authorization` header — never
  logged, never echoed in error messages.
- Privacy detector errs toward privacy: false-positive declines to
  record, false-negative trips on the next sentence.

### Known limitations

- opencode currently has no documented plugin API for registering
  MCP servers programmatically, so users add the `mcpServers.librarian`
  block to their `opencode.json` themselves (see README "Configure").
- The plugin does not (yet) take advantage of
  [anomalyco/opencode#5305](https://github.com/anomalyco/opencode/issues/5305)
  ("instant TUI commands") — when that ships, we can re-implement
  the seven verbs as instant commands directly in plugin code,
  eliminating the runtime file write.

### Source_ref shape

- This plugin uses the family-standard
  `opencode:run:<opencode-session-id>:cwd:<absolute_path>` shape
  (per AGENTS.md §4). This is a **breaking change** vs the in-tree
  `the-librarian/integrations/opencode/wrapper.sh` which used
  `opencode:project:{cwd}:session:{id}`. Users with old sessions on
  the previous shape will see them as separate from new ones; they
  can resume the old ones explicitly by `session_id`. The in-tree
  wrapper is being retired in a coordinated follow-up PR on the
  main repo.

[Unreleased]: https://github.com/JimJafar/the-librarian-opencode-plugin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JimJafar/the-librarian-opencode-plugin/releases/tag/v0.1.0
