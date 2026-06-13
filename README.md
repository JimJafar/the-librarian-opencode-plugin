<!-- librarian-archive-banner -->
> [!CAUTION]
> **This repository is archived and no longer maintained.**
>
> The Librarian's **OpenCode** integration now lives in the main monorepo —
> **[JimJafar/the-librarian](https://github.com/JimJafar/the-librarian)**.
> Install and manage every harness integration with one CLI:
>
> ```sh
> npm i -g @the-librarian/cli
> librarian install opencode
> ```
>
> Please don't open issues or PRs here — this repo is read-only. See the
> monorepo for current docs, the full integration set, and releases.

---

# the-librarian-opencode-plugin

An **[opencode](https://opencode.ai) plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory +
cross-harness narrative handoffs, backed by a **remote** Librarian MCP server.

Sibling plugins:
[the-librarian-claude-plugin](https://github.com/JimJafar/the-librarian-claude-plugin) ·
[the-librarian-codex-plugin](https://github.com/JimJafar/the-librarian-codex-plugin) ·
[the-librarian-hermes-plugin](https://github.com/JimJafar/the-librarian-hermes-plugin) ·
[the-librarian-pi-extension](https://github.com/JimJafar/the-librarian-pi-extension).

It gives opencode:

- the Librarian **memory MCP tools** (`recall`, `remember`, `flag_memory`)
  over your remote endpoint, via opencode's native `mcpServers` config;
- the **handoff MCP tools** (`store_handoff`, `list_handoffs`,
  `claim_handoff`) for atomic cross-harness handover;
- the **skill + reference tools** (`list_skills`, `get_skill`,
  `search_references`) for discovering and pulling shared agent skills;
- four **slash commands** auto-installed on first run: `/handoff`,
  `/takeover`, `/learn`, `/toggle-private`;
- a **per-turn conv-state injection hook** (`experimental.chat.system.transform`)
  that keeps the model aware of the conversation's `off_record` state,
  surviving compactions.

## Install

### 1. Install the plugin

```sh
opencode plugin the-librarian-opencode-plugin
```

(Or add `"the-librarian-opencode-plugin"` to the `plugin` array in your
`opencode.json` manually — `bun install` runs at opencode startup.)

### 2. Wire the MCP server

opencode doesn't yet expose a programmatic API for plugins to register MCP
servers, so add this block to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["the-librarian-opencode-plugin"],
  "mcpServers": {
    "librarian": {
      "type": "http",
      "url": "https://librarian.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${LIBRARIAN_AGENT_TOKEN}"
      }
    }
  }
}
```

### 3. Set env vars + restart

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

Restart opencode. On plugin init the four `*.md` command files land in
`~/.config/opencode/commands/` (or `$XDG_CONFIG_HOME/opencode/commands/`,
or `$LIBRARIAN_COMMANDS_DIR/` if you need to sandbox the path). opencode
scans command files at startup, so the verbs appear in the `/` slash-
command picker on the **next** opencode launch.

## Configure (environment variables)

| Variable | Required | Notes |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | The Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token for the endpoint (only ever sent in the request header) |
| `LIBRARIAN_AGENT_ID` | no | Canonical agent id; omit if the token is agent-bound server-side |
| `LIBRARIAN_PROJECT_KEY` | no | Default project scope |
| `LIBRARIAN_PLUGIN_DATA` | no | Override the plugin's data dir (defaults to `~/.local/share/the-librarian-opencode-plugin/`) |
| `LIBRARIAN_COMMANDS_DIR` | no | Override the commands install path (defaults to `$XDG_CONFIG_HOME/opencode/commands` or `~/.config/opencode/commands`) |

## What it does

### Four user-facing verbs

Once installed, type `/` in opencode to see four commands:

| Verb | What it does |
| --- | --- |
| `/handoff` | Author a five-section narrative and persist via `store_handoff` for cross-harness pickup |
| `/takeover` | List candidate handoffs, atomically claim, inject the document |
| `/learn` | Extract durable lessons from the conversation → `remember` (protected categories still route to proposals) |
| `/toggle-private` | Flip the `[librarian:private=on\|off]` marker — pure in-conversation, no server state, no hook |

The four verbs are the same surface in every Librarian harness (Claude
Code, Codex, Hermes, Pi).

### Per-turn conv-state injection

The single registered hook (`experimental.chat.system.transform`) fetches
the conv-state row for this opencode session and, when one exists,
`.push()`es a `<conversation-state>` block onto opencode's system-prompt
array. The model sees the current `conv_id` / `off_record` on every turn —
even after a compaction that would otherwise drop the system message.

The hook never blocks a turn: a missing row, a network failure, or a
misconfigured token all return silently and the system prompt stays
unchanged.

## Troubleshooting

**Slash commands don't appear in the `/` picker.** Check that the plugin
ran at least once: `cat ~/.config/opencode/commands/.librarian-installed`
should print the plugin version. If the directory is empty, the plugin
hasn't initialised yet — launch opencode and the commands appear on the
next restart.

**`/mcp` panel doesn't list `librarian`.** Verify `LIBRARIAN_MCP_URL` and
`LIBRARIAN_AGENT_TOKEN` are exported in the shell that launched opencode.
Test the endpoint directly:

```sh
curl -X POST "$LIBRARIAN_MCP_URL" \
  -H "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Hooks silently do nothing.** Tail
`~/.local/share/the-librarian-opencode-plugin/log.jsonl` (or wherever
`LIBRARIAN_PLUGIN_DATA` points). Every hook event writes a line there
(best-effort, never throws). If the file isn't being created, the plugin
couldn't find its data dir — check `LIBRARIAN_PLUGIN_DATA` and
`$HOME`.

**Two sessions appear on the dashboard for one opencode run.** The
race-safe bootstrap should prevent this, but if a previous run hard-exited
without the next `session.created` running reconciliation (e.g. crash
before next launch), an old `active` session may linger. The next
`session.created` will pause it.

**I edited one of the command files (`handoff.md`, `takeover.md`,
`learn.md`, `toggle-private.md`) and the plugin reverted it.** It
shouldn't — the plugin only writes a file if it's MISSING from
`~/.config/opencode/commands/`. If yours got overwritten, please file an
issue with the file contents and the steps to reproduce.

## Develop

```sh
bun install
bun run typecheck         # tsc --noEmit, strict
bun test                  # 80+ tests via bun:test
bun run validate          # package.json + entrypoint + commands shape
bun run smoke             # mock-Librarian end-to-end, 6 scenarios across 4 handlers
```

TypeScript runs native; Bun is opencode's runtime. We don't ship a `dist/` —
the source TS is the published surface.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
