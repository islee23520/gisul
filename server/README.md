# skillar MCP server

[Upgrade and compatibility notes](../docs/migration-skillar.md).
Tiny MCP server for serving personal `SKILL.md` directories from a local machine over stdio, SSH, or Streamable HTTP.

## Layout

```text
~/iyen-skills/
  skills/
    example/
      SKILL.md
      references/
      scripts/
```

By default, the server reads these roots in order:

- `~/iyen-skills/skills`
- `~/.codex/skills`
- `~/.agents/skills`

Resource URIs include the source root to avoid duplicate-name collisions:

```text
skill://skillar/iyen/example/SKILL.md
skill://skillar/codex/re0/SKILL.md
skill://skillar/agents/korean-spell-check/SKILL.md
```

## Client command

Use a local machine as an on-demand MCP server over SSH:

```json
{
  "mcpServers": {
    "skillar": {
      "command": "ssh",
      "args": ["your-host", "skillar"]
    }
  }
}
```

## Tools

The canonical surface is the SEP-2640 Skills Extension (`io.modelcontextprotocol/skills`):

- `skills/list`: enumerate served skills with verbatim frontmatter and per-file digest manifests
- `skills/get`: fetch one skill's entry by URI, listed or not
- `resources/read`: read any skill file as a standard MCP resource
- `resources/directory/read`: list a directory's direct children (declared via `directoryRead: true`)

Resource URIs include the source root id and the explicit file path:

```text
skill://skillar/iyen/example/SKILL.md
skill://skillar/codex/re0/SKILL.md
skill://skillar/agents/korean-spell-check/references/GUIDE.md
```

To be listed, a skill needs `SKILL.md` frontmatter with `name` and `description`, and `name` equal to the directory name (nested skills publish their own entries). Skills exceeding 512 files or 16 MiB total are skipped and logged to stderr.

The `skills_list`, `skills_get`, and `resources_read` tools are kept as a compatibility layer for older clients.

Trusted stdio/SSH connections also expose `create_skill` and `update_skill`:

- `create_skill({name, markdown, source?})` creates a top-level package with a complete YAML-frontmatter SKILL.md. The default source is the first configured root (`skillar` with default settings). Existing directories are never replaced.
- `update_skill({uri, markdown, expected_digest})` replaces only an existing SKILL.md, including nested skills. Use the exact canonical URI and `sha256:…` digest from the resource manifest (or Codex `load_skill.digest`). Supporting files are preserved. Reload and reconcile after a conflict.
- Names for new skills use lowercase letters, digits and hyphens, up to 64 characters. Frontmatter name must match the directory and description must be nonempty. Package size limits still apply.
- Updates reject symlinked skill paths. Atomic replacement avoids partial files; a per-root filesystem lock serializes cooperating SSH processes and digest checks prevent lost edits. External filesystem editors do not participate in this lock. If a process is terminated while holding `.skillar-write-lock`, an operator must verify no writer is active before removing that directory.
- HTTP remains read-only, including for existing bearer tokens. No new privileges are granted to issued HTTP clients. Writes store instruction text; they never execute it.

The Codex bridge exposes the same write tools. It requires `load_skill` before updates and retains manifest verification, so reread with `load_skill` after a successful write.

Set `SKILLAR_ROOT` to change the default skillar root, or use explicit source IDs to
keep existing URIs when moving content:

```sh
SKILLAR_SKILL_ROOTS="iyen=/absolute/path/skills;codex=/absolute/path/codex-skills" skillar
```

`SKILLAR_SKILL_ROOTS` uses **semicolons** between `id=absolute-directory` entries on
every platform. IDs must be unique and match `[A-Za-z0-9][A-Za-z0-9_-]*`. Spaces
and equals signs in directories are supported; semicolons are separators. A root
may itself be a symlink. Root ordering and directory names do not change source
IDs such as `skill://skillar/iyen/…`.

The older `SKILLAR_SKILLS_DIRS` remains supported with platform path delimiters
(`:` on macOS), but is deprecated because it assigns positional `root0`, `root1`
IDs. `SKILLAR_SKILL_ROOTS` takes precedence when both are set and reports that on
stderr. Malformed named-root configuration fails at startup rather than falling
back to different URI identities.

### Release identity and URI aliases

The server reads `${SKILLAR_ROOT}/release.json` on each `skills/list` and
`skills/get` request (override with `SKILLAR_RELEASE_FILE`). Responses include
`_meta.server_version`, and, when a release file exists, `_meta.release` and
`_meta.commit`. Requests fail if the release changes while being read. A release
that includes `skills: [{uri, manifest_digest}]` must match the served manifests;
unreleased changes cannot be reported as that release.

The manifest digest is SHA-256 of JSON containing `{uri, digest, size}` resource
records sorted by URI with ordinary string comparison. The digest has the
`sha256:` prefix. A release file may initially omit `skills` for compatibility;
published content snapshots should always include the manifests.

`${SKILLAR_ROOT}/aliases.json` (override with `SKILLAR_ALIASES_FILE`) is an object
mapping old file-explicit skill URIs to canonical URIs. `skills/get` resolves
same-server aliases and includes `_meta.movedFrom` when redirected. Alias chains
are bounded and cycles rejected. Read the returned canonical resource URIs;
resource reads do not silently redirect old file paths.

When serving through a public tunnel, set `SKILLAR_ALLOWED_HOSTS` to include the tunnel hostname:

```text
SKILLAR_ALLOWED_HOSTS=127.0.0.1,localhost,skillar-origin.example.com
```

## HTTP mode

The persistent deployment runs Streamable HTTP MCP on `127.0.0.1:8788`.

- `POST /mcp`: MCP endpoint, protected by bearer token.
- `GET /auth/request`: simple request form.
- `POST /auth/token-requests`: create a token request.
- `GET /auth/token-requests/:id?claim_token=...`: poll request status and receive the token once approved.
- `GET /dashboard`: admin approval dashboard.

Secrets live outside the repository:

```text
~/.config/secrets/skillar-mcp-bearer-token
~/.config/secrets/skillar-mcp-admin-token
```

## Modern and legacy protocol support

The server supports MCP `2026-07-28` per-request metadata on stdio and HTTP,
alongside legacy `initialize` connections. `server/discover` advertises the modern
version, Resources and Skills capabilities. Modern requests require
`io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities` in `params._meta`. Unsupported versions
return `-32022`; missing metadata returns `-32602`. Modern HTTP validates mirrored
version/method/name headers, origin and Accept, and uses no protocol session.
HTTP remains authenticated and read-only.

Successful discovery, catalog, resource and tool-list responses include
`resultType: "complete"`, `ttlMs: 30000`, and `cacheScope: "private"`. Directory
responses have `resultType` but are not cacheable results. All content is private
across authorization contexts, including SSH-served skills. HTTP uses `no-store`
at the transport layer; the MCP-aware bridge can use the explicit private hints.
TTL never replaces manifest verification and does not guarantee unchanged content.

`src/protocol.ts` isolates the modern wire adapter from the pinned legacy SDK.
The server shares the same handlers for both eras; the adapter does not add MRTR,
subscriptions, dynamic skills or execution capabilities. Modern client support is
scoped to the skillar methods. Existing clients can continue using legacy MCP.
The deployment smoke checks modern stdio and HTTP, plus legacy initialization.
