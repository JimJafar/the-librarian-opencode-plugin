# opencode plugin commands discovery — empirical findings

Investigation conducted on 2026-05-26 against opencode 1.14.46 + Bun 1.0.25,
following [anomalyco/opencode#5305](https://github.com/anomalyco/opencode/issues/5305).

## TL;DR

**opencode does NOT auto-discover slash commands from inside an installed
plugin's npm package.** Plugins that ship slash commands do so by **writing
markdown files at runtime** to one of opencode's scanned locations.

## Probes

### Probe 1: marker files inside a local-file plugin

Set up `.opencode/plugins/discovery.ts` (a Plugin that does nothing) and
dropped marker `.md` files at four candidate locations:

| Location | Picked up by `opencode debug config`? |
|---|---|
| `.opencode/commands/lib-marker-A-project-commands.md` | ✅ yes (baseline) |
| `.opencode/plugins/commands/lib-marker-B-sibling-commands.md` | ❌ no |
| `.opencode/plugins/discovery/commands/lib-marker-C-pluginname-commands.md` | ❌ no |
| `.opencode/plugins/discovery/.opencode/commands/lib-marker-D-pluginname-dotopencode.md` | ❌ no |

Conclusion: with a local-file plugin, opencode loads commands ONLY from the
canonical `.opencode/commands/` (or `~/.config/opencode/commands/`).

### Probe 2: opencode source code

Read [`packages/opencode/src/command/index.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/command/index.ts)
and [`packages/opencode/src/skill/index.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/skill/index.ts)
on the anomalyco/opencode main branch.

`Command.Service.layer` builds the registry from exactly three sources:

```ts
// 1. The opencode.json `command:` block.
for (const [name, command] of Object.entries(cfg.command ?? {})) { … }

// 2. MCP prompts.
for (const [name, prompt] of Object.entries(yield* mcp.prompts())) { … }

// 3. Skills (which become commands).
for (const item of yield* skill.all()) { … }
```

`Skill.Service` scans these roots:

```ts
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
```

against:

- `.claude/` and `.agents/` in `~/` and walked-up from project
- opencode's own config dirs (project `.opencode/`, global `~/.config/opencode/`)
- User-configured `cfg.skills.paths` paths
- Remote URLs in `cfg.skills.urls`

**`node_modules/` is not in any scanner root.** Confirmed by code inspection.

## What "Plugins can only create slash commands (via command markdown files)"
actually means

From the source code, the plugin's only path to ship a slash command is:

1. **Write a markdown command file to a scanned location at runtime.**
   - `.opencode/commands/<name>.md` — project-scoped
   - `~/.config/opencode/commands/<name>.md` — user-global
   - `.opencode/skill/<name>/SKILL.md` — project, via the Skill service
   - `~/.config/opencode/skill/<name>/SKILL.md` — user-global, via Skill

   A plugin can do this from a `session.created` hook.

2. **Mutate the user's `opencode.json`** to add entries to `cfg.command`.
   We reject this approach (we never mutate user config).

3. **Provide an MCP prompt.** Not applicable — the Librarian's MCP tools
   are tool calls, not prompts.

## Decision for the-librarian-opencode-plugin

**Runtime auto-install to `~/.config/opencode/commands/`** on first
`session.created`.

Rationale:
- One-time write per user, not per project — no `.opencode/commands/`
  pollution across every project the user opens with opencode.
- Idempotent: a sentinel file (`.librarian-installed`) carries the
  plugin version. If the sentinel matches the current version, no
  writes happen. If a tracked command file is missing on disk, only
  that file gets re-written (the user may have edited; we don't
  clobber).
- Discoverable: the user can see exactly what files we wrote, edit
  them, or delete them.

This matches my SPEC's original Q2 option A — the "native plugin
contributes commands" interpretation turned out not to exist; runtime
auto-install was the right call all along.

## Open follow-up

If anomalyco/opencode#5305 ships (the "instant TUI commands" plugin hook),
we could re-implement the seven verbs as instant commands directly in the
plugin code, without writing files. That would be a clean v0.2 once the
upstream feature lands.
