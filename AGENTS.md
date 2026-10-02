# Repository workflow

Read effective AGENTS.md files before edits. Fetch all remotes with prune and report
repository path, branch, upstream, worktree state and intended target before editing.
Preserve dirty or diverged work; never reset, stash, rebase or force-update it silently.
Work from an up-to-date target on a clearly named non-target branch.

Preserve fork-specific Windows deployment checks while synchronizing upstream.
Run server build and tests; run Worker typecheck and tests for upstream Worker changes.
Use the existing npm scripts and node:test conventions. Validate platform delivery
through real MCP load/read responses, keeping canonical digests intact.

Create commits only when the user explicitly requests them. Never force-push or
rewrite shared history without approval. Before handoff fetch again and report
ahead/behind, checks, any commits and intended merge destination.

User skill content and secrets are runtime data, not server repository source.
Never modify installed OMO packages or interrupt OMO sessions during this work.
