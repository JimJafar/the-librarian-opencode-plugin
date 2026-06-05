# AGENTS.md

You're an AI agent working on this repo. It's part of
[The Librarian](https://github.com/JimJafar/the-librarian) — a portable
memory + session layer for AI agents, open source, designed for
production use by people we'll never meet. Read this before your first
commit. Follow it on every change.

## 1. What this repo is

An [opencode](https://opencode.ai) plugin for The Librarian — gives
opencode remote memory tools, cross-harness handoffs (/handoff /takeover /learn /toggle-private), and a per-turn
conv-state injection hook.
Distributed as an npm package; installed via opencode's native
`"plugin": [...]` config.

## 2. House rules

### Be honest about what you ran

Never claim "tests pass" without running them. Never say a build works
because it "should." If a step was skipped, say so. If something is
unverified, label it. Your next session, and every contributor reading
your PR, inherits whatever you said — make sure it's true.

### Privacy beats convenience

This is The Librarian. Privacy is the product, not a feature. The
off-record gate stops all automatic recording — never bypass it, never
"just for debugging." Bearer tokens go in headers, never in URLs or
logs or error messages. The privacy-marker list is shared across all
five Librarian plugins (Claude Code, Codex, Hermes, OpenCode, Pi) —
**five peer implementations of the same behaviour, no single canonical
source any longer.** Any marker-list change must land coordinated
across all five repos in one go (or none).

### Fail-soft, never block the user's turn

A Librarian / network / parse failure must never throw out of a hook,
never block opencode's turn, never leak a stack trace into the model's
context. Log to the local sidecar, return cleanly, move on. The
Librarian server can be down for an hour and the user's day shouldn't
notice.

### The cross-repo contracts are sacred

Three things stay consistent across the family. Don't change any of
them in one repo without changing all of them in the same coordinated
push, and never invent new ones unilaterally:

- **Cross-harness verbs:** `/handoff`, `/takeover`, `/learn`,
  `/toggle-private`. Canonical contract:
  [`the-librarian/docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md).
- **Memory state model:** memories are `active | proposed | archived`.
  The retired verbs (`archive`, `restore`, `delete`, `status`,
  `confirm_memory`, `reject_memory`) are gone for good.
- **`source_ref` shape:** `<harness>:<run-id>:cwd:<abs>` when the run
  id is available, else `cwd:<abs>`.

### Respect your consumers

Open source means people depend on what we ship. Treat that with care.

- **Every user-visible change updates `CHANGELOG.md`.** Add an entry
  under `## [Unreleased]` in the same PR that ships the change — not
  a follow-up. Internal-only refactors can skip; when unsure, add the
  entry (cheap, erasable).
- **Error messages teach.** "Invalid input" is not an error message.
  "Expected ISO-8601 timestamp, got '2026-13-99'" is. Assume the
  reader is new and tired.
- **README is the contract.** If it says one-liner install, that has
  to work on a fresh machine. If it claims a feature, the feature
  exists.

### Open a PR, never push to main

Always branch and PR. One change per PR. Conventional commit subject
(`<type>(<scope>): <subject>`) and a body that explains the *why*; the
diff explains the *what*. When an AI agent meaningfully contributed,
include a `Co-Authored-By:` trailer.

### Releases

User-visible PRs need a release. Bump-size rule (PATCH / MINOR / MAJOR),
trigger criteria, and the full per-repo procedure (bump `package.json`,
CHANGELOG move, tag, GitHub release, **then `npm publish` — this is the
only plugin in the family with an npm artifact**) live in
[`docs/release.md`](./docs/release.md); the cross-family runbook
covering all six repos is at the monorepo's
[`docs/release-runbook.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/release-runbook.md).
Read those before cutting a release — don't reinvent the steps.

### Tests are part of the change

Bug fix? Write a regression test first that fails, then make it pass.
New behaviour? It has tests. Trivial doesn't exempt it. Test names
describe behaviour, not function names — `"off the record ends the
attached session within one turn"` beats `"test_handler_3"`. Flakey
tests are bugs; don't paper over with retries.

### Never commit secrets

Tokens, API keys, passwords — they live in environment variables or
the user's secret store, never in code, tests, fixtures, or commit
messages. Bearer tokens never appear in stderr, log files, error
responses, or telemetry. `redirect: "error"` on every outbound HTTPS
call that carries credentials, so a 3xx can't leak the token
cross-origin.

### Don't touch what you don't understand

Comments that say "this is here because of X," tests asserting
non-obvious invariants, ostensibly-dead code with a `// HACK:` or
`// race:` nearby — read them twice. Most of the surprising code in
this family exists because of a real race or a real exploit. Verify
with the human before deleting "obvious dead code."

### When unsure, ask

You don't get points for confidence. You get points for being right.
Surface trade-offs instead of guessing: *"option A is faster but
loses event ordering on a crash; option B is durable but slower —
which matters here?"* Asking makes you a better collaborator, not
a worse one.

## 3. Build, test, verify

```sh
bun install
bun run typecheck   # tsc --noEmit, strict
bun test            # full suite via bun:test
bun run validate    # package.json + entrypoint + commands shape
bun run smoke       # mock-Librarian end-to-end (post-Task 13)
```

CI runs the first four on Bun latest.

## 4. Gotchas (repo-specific)

- **TypeScript runs native; no committed bundle.** Bun is opencode's
  runtime and executes `.ts` directly. Unlike the Codex / Claude
  plugins, we don't `npm run build` to a `bin/` dir. `dist/` is
  gitignored.
- **Slash commands are written at runtime, not auto-discovered.** Per
  Task 0 (see [`notes/commands-discovery.md`](./notes/commands-discovery.md))
  opencode does NOT scan inside `node_modules/` for command files.
  The plugin's `commands/` directory is the SOURCE; the
  `ensure-commands` handler writes them to
  `$LIBRARIAN_COMMANDS_DIR` (override),
  `$XDG_CONFIG_HOME/opencode/commands`, or
  `~/.config/opencode/commands` (in that precedence) on plugin init.
  Sentinel `.librarian-installed` prevents re-write churn; user-edited
  files are never clobbered.
- **Private mode is in-conversation only (sessions-rethink PR 4).** The
  natural-language `chat.message` privacy gate is retired. Private mode
  is now an in-conversation `[librarian:private=on|off]` marker the LLM
  handles directly via the `/toggle-private` verb. No server flag, no
  hook, no persisted state. Compaction can erase the marker (default
  falls back to OFF) — documented limitation accepted in exchange for a
  zero-dependency privacy model.
- **MCP wiring stays in the user's `opencode.json`.** opencode has no
  programmatic API for registering MCP servers from a plugin. README
  shows the four-line `mcpServers.librarian` snippet users add.

## 5. `experimental.chat.system.transform` monitoring plan

The §4.9 conv-state injection rides on opencode's
`experimental.chat.system.transform` hook. The `experimental.*`
prefix is the SDK's signal that the namespace can graduate, change
shape, or be removed between minor versions — so the implementation
needs an active monitoring posture, not "set and forget". Four
mechanisms keep us honest (cf.
[`docs/specs/opencode-conv-state-injection-spec.md`](../the-librarian/docs/specs/opencode-conv-state-injection-spec.md)
§7.1):

1. **Pin the SDK + run `tsc --noEmit` in CI.** `@opencode-ai/plugin`
   is pinned in `package.json`; CI runs `tsc --noEmit` on every PR.
   If a bump changes the hook's input/output shape, the typecheck
   fails before the change ships.
2. **Grep the SDK CHANGELOG on every bump.** When bumping
   `@opencode-ai/plugin`, search the upstream CHANGELOG for the
   string `experimental.chat.system.transform` (and "system" /
   "system prompt"). If anything surfaces, read it before merging.
3. **Watch the namespace graduate.** The day the hook moves out of
   `experimental.*` (e.g. to `chat.system.transform` or
   `chat.system.augment`), rewire `src/index.ts` and `src/handlers/
   system-transform.ts` to the new name. The grep mechanism above
   is the trigger.
4. **Quarterly eyeball re-test.** Once per quarter (or on every SDK
   bump, whichever is sooner), run the eyeball test from the spec
   §7 step 4: ask "is this conversation off the record?" in a real
   opencode session with a seeded `conv_state` row (`off_record:
   true`), verify the model reads the injected `off_record` value
   correctly. This catches silent-discard regressions (the residual
   upstream issue tracked at opencode#17100) that no automated check
   could.
