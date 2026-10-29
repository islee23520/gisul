# Upgrade from gisool / gisul to Skillar 0.2.0

The server repository is `changeroa/skillar`; the catalog is `changeroa/iyen-skills`.
The public local CLI package is `skillar@0.2.0`, with primary executable `skillar`.
The same package retains `gisool` as a migration executable. The separate Node
registry package is `skillar-mcp`, with `skillar-mcp` and legacy `gisul` executables.
Repository scripts, client bundles and templates now use Skillar names.

## Local state and configuration

The two global packages both own a `gisool` executable. Installing `skillar`
over an installed global `gisool` package fails with npm **EEXIST** at
`<prefix>/bin/gisool`. Do not use `--force` to overwrite that owned binary.
Perform the package handoff during a controlled daemon stop:

1. Download and validate the new package **before** removing the working package.
   For example, `npm pack skillar@0.2.0 --pack-destination "$handoff" --json`
   downloads the tarball with npm's registry integrity check. Save the returned
   version/integrity record, inspect the tar contents, and verify `0.2.0` with
   `npm exec --yes --package "$handoff/skillar-0.2.0.tgz" -- skillar --version`.
   Keep the previous package/archive and service definition available for recovery.
2. Stop the existing daemon through its actual service manager. For the standard
   legacy macOS installation, use
   `launchctl bootout "gui/$(id -u)/dev.gisool.daemon"`; for Linux use
   `systemctl --user stop gisool.service`. Inspect the installed definition first
   and use its actual identity. A bare process kill is insufficient for a service
   configured to restart automatically. Foreground daemons must also be stopped.
3. After the daemon has exited, preserve the **entire selected home** (normally
   `~/.gisool`), including SQLite database/WAL files, token, config and backups,
   plus the service definition. For example,
   `cp -pR "$HOME/.gisool" "$handoff/gisool-home"` applies to that standard layout;
   use the explicit/custom home when configured. Do not move or delete the original.
4. Run `npm uninstall -g gisool`, then
   `npm install -g "$handoff/skillar-0.2.0.tgz"`. Both commands must target the
   same verified npm prefix. Confirm `skillar --version` and `gisool --version`
   both report `0.2.0`. If installation fails, keep the daemon stopped and restore
   the preserved previous package/definition before restarting it.
5. Review `skillar init --dry-run`, then run `skillar init` to refresh client
   paths and the existing service definition. Skillar reuses the selected home and
   legacy service identity. Run `skillar doctor` and verify the expected history,
   token and roots. Installing the package alone does not restart or edit a service.

`$handoff` is an operator-created private recovery directory outside the install
prefix. These are release instructions, not a request to operate the host during
source validation. The actual host switch remains a separate controlled action.

The collision and handoff were executed in an isolated npm prefix using the actual
built Skillar 0.2.0 tarball and a fixture package owning the old `gisool` binary:
the direct install failed with `EEXIST`, removing the old package then installing
the tarball succeeded, both executable names returned `0.2.0`, and the fixture's
`~/.gisool` config/database bytes remained unchanged. No real global package or
live service was changed by that check.

Home selection is deterministic:

1. Nonempty `SKILLAR_HOME`.
2. Nonempty legacy `GISOOL_HOME`.
3. `~/.skillar` if it contains a config, token or database.
4. Existing `~/.gisool`.
5. New `~/.skillar`.

An empty `~/.skillar` does not hide existing legacy history. A configured new home
takes precedence when both homes exist; Skillar never merges, moves or deletes the
other home. A malformed config in the selected home still fails validation. Set
an explicit home to select the intended installation if both contain state.

Within that home, an existing `gisool.db` is reopened in place. New stores use
`skillar.db`. If **both** files exist in one home, startup refuses to choose;
preserve both and explicitly resolve the store before starting. There is no schema
or history rewrite for this rename. Tokens, backups, manifests, imported history,
root IDs, URI references and captured JSON retain their identities. New default
catalog roots use ID `iyen` and path `~/iyen-skills/skills`; saved roots such as
`gisul` keep their original ID and path. Local URIs remain
`skill://local/<rootId>/...`.

New settings and templates use `SKILLAR_*`. The corresponding `GISOOL_*` local
variables and `GISUL_*` registry/worker variables remain accepted as fallback.
Explicit new values take precedence. Copied capture hooks and extensions use the
same home selection, even when neither environment prefix is forwarded.

## Services and client settings

Fresh installs create `dev.skillar.daemon` on macOS or `skillar.service` on Linux.
When the legacy `dev.gisool.daemon.plist` or `gisool.service` exists, init updates
that exact file and uses its existing identity for unload/start/status/removal.
It does not install a second differently named daemon. The new definition pins
`SKILLAR_HOME` to the selected store. Existing service restarts occur only when
the operator runs init/service installation; no live migration is performed by
installing this source or building the package.

Codex recognizes the old `# >>> gisool managed` / `# <<< gisool managed` block
and replaces it with one current block containing one OTel exporter. Unmanaged
local server/OTel tables remain conflicts. Existing `gisool` local MCP keys in
Claude, Gemini, Cursor, OmO and Gajae are reused; fresh local registrations use
`skillar`. A remote `skillar` entry is a conflict and is never overwritten with
the local daemon. Retired hosted `gisul` entries remain independently detectable.
Claude capture hooks are refreshed once, including both tool-name namespaces;
other hooks are preserved. OmO/Gajae reuse an installed `extensions/gisool`
directory instead of creating a second forwarding extension.

OpenClaw retains an installed local `gisool` plugin and `gisool-discovery` hook ID
when updating their implementation. Existing conversation-access settings still
apply. Discovery hooks recognize the historical markers to avoid adding guidance
twice. Remote bundle removal remains an explicit runtime operation. Hosted OAuth
bridges reuse existing `gisul/auth` directories rather than creating new credentials.
Hosted client installers refuse an existing old provider registration before adding
a new provider or loader; those installations require an explicit preserved
migration in the runtime's own plugin/config manager. GJC also refuses to add a
new prompt bundle while the legacy bundle is installed.

## Protocol, traces and immutable catalogs

MCP server identity is `skillar`. New trace metadata is `app.skillar/traceId`;
`app.gisool/traceId` is accepted on old clients. New immutable read pins use
`app.skillar/commit`; the Worker accepts `io.gisul/commit` from installed bridges.
New hosted URIs use `skill://skillar/iyen/...` and `pack://skillar/iyen/...`.
Explicitly configured source IDs remain as configured. The retired `gisul`
authority setting is normalized to `skillar`.

The registry accepts retired `skill://gisul/gisul/...` and
`skill://gisul/codex/...` aliases. The bridge requires the returned `movedFrom`
metadata and only permits that retired authority/root pair to cross to the new
`skillar/iyen` namespace; arbitrary foreign authorities/roots remain rejected.
Existing immutable R2 skill/pack inventories and pins are readable in their old
namespace. Newly authored packs must use canonical current member URIs. No R2
objects or release digests are rewritten.

Historical `gisoolMcp` JSON and `mcp__gisool__*` telemetry continue to reconcile and
count as skill calls in usage reports and dashboard call views. The old field is
read as compatibility evidence; stored payloads are not relabeled. The public
bridge helper is `createSkillarEventLog`; `createGisulEventLog` remains an alias.
Admin/dashboard cookies, claim-token headers, OAuth `gisul:login:` KV keys and
`__Host-gisul-` browser bindings remain compatible. The `.gisul-write-lock` name
is retained so old/new registry processes coordinate on the same lock.

## External identities retained deliberately

The former personal Cloudflare deployment was retired on 2026-10-29. Its names
remain in historical deployment examples and compatibility tests; they do not
identify a currently maintained endpoint. Organization resources are separate.
The rename does not recreate or deploy any of these resources:

| Identity | Where / reason |
| --- | --- |
| `gisul-mcp`, `gisul-arkpoint` | Retired personal / separate organization Cloudflare Workers in `worker/wrangler*.jsonc` |
| `gisul-skills-releases`, `gisul-arkpoint-releases` | Existing R2 bucket names; immutable releases stay in place |
| `gisul-mcp.changeroa.workers.dev` | Retired personal machine endpoint in deployment documentation |
| `gisul.iyendev.com`, `gisul.arkpoint.dev` | Existing custom domains and OAuth callback hosts |
| `gisul-arkpoint-production` | Existing workflow concurrency identity, preserving serialization |
| `Ark-Point/gisul`, `Ark-Point/gisul-skills` | Existing organization deployment/fork identities, separate from the renamed changeroa repositories |
| `~/gisul`, `com.iyendev.gisul-mcp` | Existing Mac mini deployment root/launchd label defaults; explicit deploy overrides remain available |
| `~/.config/gisul-worker-dev-tools/mcp-bearer` | Existing documented private credential location |

`server/ops/` contains **new-install templates**, not evidence that a service,
domain, tunnel or credential path has been created. Existing deployments retain
their real identities until a separate explicit infrastructure migration.

## Remaining old-name inventory

All remaining old names belong to the compatibility paths described above,
regression fixtures exercising those paths, the external identities in the table,
or immutable historical reports/evidence. Historical records under
`docs/evidence/`, `docs/deployments/`, dated `docs/*20*`,
`docs/research/2026-10-13-gisul-prd-research.md` and `docs/SESSION_CONTEXT.md` preserve
observed names, paths, hashes, repository links and traces. They are not active
configuration. To enumerate references after a change, run
`rg -n -i 'gisool|gisul' --glob '!**/node_modules/**' --glob '!**/dist/**'`.

The upgrade regressions are in `local/test/rebrand-migration.test.mjs`,
`local/test/analysis-usage.test.mjs`, `server/test/codex.test.mjs` and
`worker/test/direct.test.mjs`, `server/test/rebrand-migration.test.mjs` and
`server/test/runtime-clients.test.mjs`. They exercise real SQLite reopening, repeated client
planning, matching service commands, historical attribution/usage, MCP alias
validation, deployed legacy bindings and pinned immutable reads. Live service,
publishing, production deployment and external resource migration are separate
release operations.
