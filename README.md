# the-librarian-opencode-plugin

An **[opencode](https://opencode.ai) plugin** for
[The Librarian](https://github.com/JimJafar/the-librarian) — durable memory +
cross-harness session lifecycle, backed by a **remote** Librarian MCP server.

Sibling plugins:
[the-librarian-claude-plugin](https://github.com/JimJafar/the-librarian-claude-plugin) ·
[the-librarian-codex-plugin](https://github.com/JimJafar/the-librarian-codex-plugin) ·
[the-librarian-hermes-plugin](https://github.com/JimJafar/the-librarian-hermes-plugin) ·
[the-librarian-pi-extension](https://github.com/JimJafar/the-librarian-pi-extension).

It gives opencode:

- the Librarian **memory + session MCP tools** (`recall`, `remember`,
  `verify_memory`, `start_session`, `checkpoint_session`, …) over your remote
  endpoint, via opencode's native `mcpServers` config;
- seven **`/lib-session-*` slash commands** (start, list, resume, checkpoint,
  pause, end, search), auto-installed on first run;
- **automatic session lifecycle** — sessions start on `session.created`,
  record per-turn events on `session.idle`, checkpoint on `session.compacted`
  and on a debounced threshold (≥ 10 min OR ≥ 20 turns), reconcile stale
  active sessions on every `session.created`;
- an **off-record privacy gate** — natural-language markers (`off the
  record`, `keep this between us`, …) and `/lib-toggle-private` end the
  attached session **within the same turn** and suppress further recording
  until you go back on the record.

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

Restart opencode. On the first `session.created` the plugin writes the
seven `lib-session-*.md` files to `~/.config/opencode/commands/` — they
appear in the `/` slash-command picker immediately.

## Configure (environment variables)

| Variable | Required | Notes |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | The Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token for the endpoint (only ever sent in the request header) |
| `LIBRARIAN_AGENT_ID` | no | Canonical agent id; omit if the token is agent-bound server-side |
| `LIBRARIAN_PROJECT_KEY` | no | Default project scope for sessions |
| `LIBRARIAN_PLUGIN_DATA` | no | Override the plugin's data dir (defaults to `~/.local/share/the-librarian-opencode-plugin/`) |

## What it does

### Memory + sessions (`/lib-session-*` slash commands)

Once installed, type `/` in opencode to see the seven verbs:

| Verb | Tool called |
| --- | --- |
| `/lib-session-start [title] [--private]` | `start_session` |
| `/lib-session-list [--include-ended]` | `list_sessions` |
| `/lib-session-resume [<id\|number>]` | `continue_session` |
| `/lib-session-checkpoint` | `checkpoint_session` |
| `/lib-session-pause` | `pause_session` |
| `/lib-session-end` | `end_session` |
| `/lib-session-search <query>` | `search_sessions` |

The canonical contract lives at
[`docs/slash-commands.md`](https://github.com/JimJafar/the-librarian/blob/main/docs/slash-commands.md)
in the-librarian. Every Librarian harness honours the same verb names.

### Automatic recording (the hooks)

Once installed + env vars set, the plugin records every opencode run as a
Librarian session without you asking:

- **First `session.created`**: a session starts bound to
  `source_ref = opencode:run:<opencode-session-id>:cwd:<abs>` (or
  `cwd:<abs>` fallback). Race-safe under concurrent `chat.message` /
  `session.created` fires.
- **Every `session.idle`**: a `record_session_event` (type=message,
  generic per-turn summary).
- **Every `session.compacted`**: `checkpoint_session` — the rolling
  summary stays in sync with what opencode actually carries forward.
- **Idle**: every 10 minutes OR every 20 turns since the last
  checkpoint, `session.idle` also calls `checkpoint_session`. Tunable
  in `src/handlers/checkpoint-policy.ts`.
- **On every `session.created`**: list any active sessions for this
  `source_ref` and pause anything that isn't ours — so a hard exit
  doesn't leave you with two `active` sessions on the dashboard.

### Privacy (the off-record gate)

Natural-language markers in any user prompt flip the plugin to off-record.
opencode's `chat.message` hook runs **pre-LLM**, so the marker turn itself
is NOT recorded (a meaningful win over the Codex / Claude / Hermes plugins
which have a documented one-turn lag).

- **Going private:** `off the record`, `keep this between us`, `don't
  remember this`, `do not remember this`, `don't save this`, `don't store
  this`, `private from here`, `this is a private session`. Also
  `/lib-toggle-private`.
- **Coming back:** `back on the record`, `you can remember again`, `end
  private mode`, `this can be remembered`. Also `/lib-toggle-private`.

While private, **no MCP recording call is ever made** — the attached
session is ended with a neutral reason on entering private, and
`session.idle` / `session.compacted` become no-ops. The detector is the
same one used by the canonical TS source and the four sibling plugins; it
errs toward privacy.

## Troubleshooting

**Slash commands don't appear in the `/` picker.** Check that the plugin
ran at least once: `cat ~/.config/opencode/commands/.librarian-installed`
should print the plugin version. If the directory is empty, the plugin
hasn't fired `session.created` yet — open a session and the commands
appear immediately.

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

**I edited one of the `lib-session-*.md` files and the plugin reverted
it.** It shouldn't — the plugin only writes a file if it's MISSING from
`~/.config/opencode/commands/`. If yours got overwritten, please file an
issue with the file contents and the steps to reproduce.

## Develop

```sh
bun install
bun run typecheck         # tsc --noEmit, strict
bun test                  # 80+ tests via bun:test
bun run validate          # package.json + entrypoint + commands shape
bun run smoke             # mock-Librarian end-to-end, all 5 handlers
```

TypeScript runs native; Bun is opencode's runtime. We don't ship a `dist/` —
the source TS is the published surface.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
