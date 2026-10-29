# Gisul resource discovery startup

Gisul serves versioned skills and their supporting resources over MCP. Resource discovery must return the same canonical URIs, metadata, validation and limits while avoiding unnecessary file-content hashing during `resources/list`. Real reads and release-integrity checks remain authoritative.

Stack: Node.js 24, TypeScript, MCP SDK and node:test; Windows host with a Docker Linux runtime.
