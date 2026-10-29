<h1 align="center">skillar</h1>
<p align="center"><strong>Find your local skills. See how your agents use them.</strong></p>
<p align="center"><a href="https://github.com/changeroa/skillar/blob/main/README.md">Project overview</a> · <a href="https://github.com/changeroa/skillar/blob/main/README.ko.md">한국어</a></p>
<p align="center">
  <a href="https://www.npmjs.com/package/skillar"><img src="https://img.shields.io/npm/v/skillar?color=c44b2b&amp;label=npm" alt="npm version"></a>
  <a href="https://github.com/changeroa/skillar/blob/main/local/package.json"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524.15-333333" alt="Node.js 24.15 or newer"></a>
  <a href="https://github.com/changeroa/skillar/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-333333" alt="MIT license"></a>
</p>
<p align="center"><img src="https://raw.githubusercontent.com/changeroa/skillar/main/docs/assets/gisul-workshop.png" width="960" alt="An articulated arm selects an instruction card from a cabinet and brings it to a workbench. Black ink and vermilion on warm ivory."></p>

skillar is a local skill router for coding agents. One daemon on `127.0.0.1` indexes your existing `SKILL.md` folders, serves them over MCP, and records searches and reads in a local dashboard. Skill files stay in place.

[Install](#install) · [Connect your agents](#connect-your-agents) · [Settings](#settings) · [MCP reference](#skills-over-mcp)

## Install

Requires **Node.js 24.15+** on **macOS or Linux**.

> **Existing gisool installation?** Follow the [safe migration guide](https://github.com/changeroa/skillar/blob/main/docs/migration-skillar.md) **before installing**. The packages share the `gisool` executable, so a direct global install fails with `EEXIST`. Preserve your state and perform the controlled package handoff; do not use `--force`.

For a fresh installation:

```sh
npm install -g skillar
skillar init --dry-run    # review configuration and service changes
skillar init              # connect detected runtimes and start the background service
skillar open              # view the local dashboard
```

The package installs `skillar` and the compatibility command `gisool`. For source installation, see [Develop](#develop).

## What you get

| Capability | How it works |
| --- | --- |
| Local discovery | `search_skills` returns ranked candidates from skill roots already on your machine. |
| On-demand reads | Hosts read the chosen `SKILL.md` and supporting files with MCP `resources/read`. |
| Session history | Review searches, loads, supporting reads, native-use observations, and dashboard flows. |
| Reversible setup | Preview configuration changes, keep per-run backups, and roll back with `init`. |

## Supported runtimes

| Runtime | `--runtime` ID |
| --- | --- |
| Claude Code | `claude-code` |
| Codex | `codex` |
| Gemini CLI | `gemini` |
| Cursor | `cursor` |
| OmO | `omo` |
| Gajae Code | `gajae` |
| OpenClaw | `openclaw` |

Packs configure MCP endpoints and runtime-specific telemetry or capture hooks. Capture coverage varies by runtime; the [tracing guide](https://github.com/changeroa/skillar/blob/main/local/docs/skill-tracing.md) documents what is observed and the herdr requirement for pane/session tracing.

Both modern MCP revision **2026-07-28** and the legacy `initialize` handshake are supported. Reading skill bodies requires a host resource reader. See the [protocol reference](#skills-over-mcp) for compatibility and transport limits.

## Connect your agents

Preview what would change, without writing anything:

```sh
skillar init --dry-run
```

The dry run prints a diff for each runtime configuration it would change and the service it would install.
Depending on the runtime, changes include MCP registration, telemetry export, or capture hooks. Then apply it:

```sh
skillar init                          # every detected runtime
skillar init --runtime codex,claude-code
skillar init --no-service             # do not install the LaunchAgent / systemd user unit
```

Every run backs up the files it changes under `~/.skillar/backups/`. Undo with:

```sh
skillar init --rollback               # newest run
skillar init --rollback --all         # every run
```

## Run

`skillar init` installs a LaunchAgent (macOS) or systemd user unit (Linux) that keeps the daemon running. To run it in
the foreground instead:

```sh
skillar serve                         # default port 8799
skillar serve --port 8800
```

Open the dashboard (sessions, per-session trace, flow, and weekday-by-hour heatmap):

```sh
skillar open                          # opens the browser
skillar open --print                  # prints the URL only
```

Manage the background service:

```sh
skillar service status
skillar service install
skillar service remove
```

Check the installation:

```sh
skillar doctor                        # service, daemon, token mode, FTS5, roots, index freshness, hooks, backups
skillar doctor --json
```

Measure search quality against recorded or hand-written cases:

```sh
skillar eval
skillar eval --cases cases.json --json
```

## Skill tracing

herdr is required for skill tracing; `skillar doctor` checks its socket connection. skillar joins agent sessions
to panes and compares observed skill use with registered workflows without restricting agents.
See [Skill tracing](https://github.com/changeroa/skillar/blob/main/local/docs/skill-tracing.md) for capture details, attribution limits, and the orchestrator protocol.

## Export and import

Move your skillar setup (skill roots, config, eval cases, aliases) to another machine:

```sh
skillar export ~/skillar-backup                  # settings only
skillar export ~/skillar-backup --with-history   # also sessions, events, and loads
skillar import ~/skillar-backup --dry-run        # preview what would be added
skillar import ~/skillar-backup                  # merge; existing keys are kept
```

Import never overwrites existing settings. Run `skillar init` afterwards to connect the runtimes on the new machine.

### Repair historical load attribution

After an upgrade or history import, explicitly reconcile pending loads against evidence already in the database:

```sh
skillar repair-loads --from 1800000000000 --to 1800000000100 --limit 100 --json
skillar repair-loads --from 1800000000000 --to 1800000000100 --limit 100 --after <next-event-id> --json
```

`--from` and `--to` are required epoch milliseconds, selecting `[from,to)`. Each invocation examines at most
`--limit` pending loads (default 100, maximum 1000), ordered by timestamp and local recording order.
Optional `--session <id>...` restricts the candidate sessions; it does not force attribution to them.
The JSON result contains `examined`, `repaired`, `pending` within this batch, and `next`. Continue with
`--after` while `next` is non-null, keeping the same range and session scope. Cursors also advance past
ambiguous loads; they are event IDs for this database, not portable recording-order guarantees.

Only uniquely supported evidence repairs a load. Missing captured text and multiple candidates remain pending;
retained URI proof survives retention, and later contradictory evidence can still retract an attribution.
Re-running the command is safe. It does not ingest new events, change capture settings, or make GET reports write.

## Settings

`~/.skillar/config.json` (created on first run, mode 0600). `SKILLAR_HOME` selects a different home; it does not move existing data. Legacy home/database selection follows the [migration guide](https://github.com/changeroa/skillar/blob/main/docs/migration-skillar.md#local-state-and-configuration).

Example settings:

```json
{
  "port": 8799,
  "captureLevel": "full",
  "retentionDays": null,
  "roots": [{ "id": "agents", "path": "~/.agents/skills" }],
  "runtimes": {}
}
```

- `captureLevel` controls how prompt and search text is stored:
  - `full` (default): the text as sent.
  - `redacted`: recognized secrets (tokens, keys, passwords) are masked and the text is cut to 2048 characters.
  - `metadata`: no text at all, only its SHA-256 digest and length. The dashboard shows "prompt not captured".
- `retentionDays`: `null` keeps history forever; a number deletes sessions older than that many days at startup and
  once a day.
- `roots`: skill folders to index in place. Defaults cover `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`,
  `~/.gemini/skills`, `~/.omo/agent/skills`, `~/.gjc/agent/skills`, `~/.openclaw/skills`, and `~/iyen-skills/skills`.
  skillar never copies or edits skill files.

Restart the daemon after editing the config.

## Files

| Path | Purpose |
| --- | --- |
| `~/.skillar/config.json` | settings above (paths below show a fresh installation) |
| `~/.skillar/token` | bearer token (0600) shared with the runtime configs |
| `~/.skillar/skillar.db` | SQLite store: skills index, sessions, events, loads; legacy `gisool.db` stays in place |
| `~/.skillar/logs/daemon.log` | daemon log, rotated at 5 MB |
| `~/.skillar/backups/` | per-run backups used by `skillar init --rollback` |

## Privacy

The local daemon stores its index and telemetry locally and does not upload captured telemetry. Connected agents and their model providers handle data separately. It listens on `127.0.0.1` only; MCP, ingest, and API requests require the local bearer token (the dashboard also uses a local authenticated cookie). Prompts, search queries, and skill usage are stored in the selected local SQLite store.

Capture defaults to `full`. Use the [settings](#settings) to select `redacted` or `metadata` and set retention. Redaction masks recognized secret patterns; it does not guarantee every secret is removed. Capture levels do not anonymize session IDs or paths.

## Skills over MCP

The server implements stable SEP-2640: `server/discover` advertises `tools`, `resources`, and
`extensions["io.modelcontextprotocol/skills"]`. `search_skills` is the only tool. Use it to choose a candidate,
then read the returned `SKILL.md` URI through the host's resource reader on this server. Relative references
resolve against the skill root (the directory containing `SKILL.md`); supporting files are read only as needed.
`skills/list` and `skills/get` provide verbatim frontmatter and complete per-file SHA-256/size manifests.
The optional directory-read feature is not advertised; directories can be inferred from the manifest.

For modern requests, every call, including `server/discover`, carries `params._meta` with
`io.modelcontextprotocol/protocolVersion: "2026-07-28"` and
`io.modelcontextprotocol/clientCapabilities: {}`. Include `io.modelcontextprotocol/clientInfo`
with `{name, version}` for runtime attribution. HTTP additionally requires `MCP-Protocol-Version`,
`Mcp-Method`, and (for tool calls and resource reads) `Mcp-Name`, matching the body.
Use `Accept: application/json, text/event-stream` and the bearer token.
Modern requests need no initialization handshake or protocol session; GET and DELETE on `/mcp` return 405.
The stdio proxy forwards modern requests unchanged.

### Legacy clients (before 2026-07-28)

The server is dual-era. A request without modern `_meta` and without a modern `MCP-Protocol-Version` header
is served under legacy semantics: `initialize` negotiates the requested revision (or answers `2025-11-25`
for unknown ones) with the same capabilities and instructions as `server/discover`. Over HTTP it returns an
`Mcp-Session-Id` whose only state is `clientInfo` for runtime attribution; unknown session IDs (e.g. after a
daemon restart) are served anonymously instead of rejected. Over stdio the proxy keeps `clientInfo` for the
process. Legacy results omit `resultType`, `ttlMs`, `cacheScope`, and the `serverInfo` `_meta`; legacy HTTP
errors are JSON-RPC errors with status 200. `ping` and an empty `resources/templates/list` are answered.
The deprecated HTTP+SSE transport (GET stream) is not offered, so 2024-11-05 clients connect over stdio.

All cacheable results include `resultType: "complete"`, `ttlMs: 60000`, and `cacheScope: "private"`.
List methods use opaque `cursor`/`nextCursor` pagination. The search tool uses its own `offset`/`limit`.
Tool schemas use JSON Schema 2020-12. Search is limited to 120 invocations per minute per daemon.

The catalog rejects invalid Agent Skills names/frontmatter and skills above 512 files or 16 MiB.
Manifests include dotfiles, dependencies, and nested skills. Skills containing symlinks or other non-regular
entries are rejected rather than served incompletely. Duplicate names are retained at distinct URIs so
hosts can disambiguate their configured roots.

A `resources/read` of a published `SKILL.md` is recorded as a dashboard `load` observation; other files
produce `read_file` observations. These do **not** activate skills, confer approval, or grant execution permissions.
Hosts own origin binding, integrity verification, consent, and activation. To join reads to a search, send
its `trace_id` as `_meta["app.skillar/traceId"]`; ordinary vendor session metadata also preserves attribution.
No prior read or connection is required. A changed file fails closed until the catalog refreshes; the host
refreshes `skills/get` and verifies against the new manifest before use.

For Codex builds with gated modern support, enable `features.mcp_2026_07_28` for third-party HTTP servers;
the separate hosted Apps flag does not apply to skillar. Client-wide experimental flags are not edited by the pack.

## Develop

From a repository checkout (run these at the repository root):

```sh
npm --prefix local ci
npm --prefix local run build
npm link ./local                     # make the built CLI available locally
npm --prefix local run typecheck
npm --prefix local test              # unit tests plus test/e2e, which spawns the real daemon in a sandbox HOME
node local/bench/search.mjs --check
node local/bench/mcp-mutations.mjs  # each regression is injected in memory; files stay unchanged
```

Architecture: [daemon and storage design](https://github.com/changeroa/skillar/blob/main/docs/skillar.md).

## More documentation

[Project overview](https://github.com/changeroa/skillar/blob/main/README.md) · [Upgrade & compatibility](https://github.com/changeroa/skillar/blob/main/docs/migration-skillar.md) · [MIT license](https://github.com/changeroa/skillar/blob/main/LICENSE)

The former personal Cloudflare deployment is retired. The local CLI needs no hosted service; separate registry and organization deployment context is covered in the [project documentation](https://github.com/changeroa/skillar/blob/main/README.md#remote-registry-and-team-distribution).
