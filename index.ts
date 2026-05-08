/**
 * claude-peers
 *
 * Peer discovery and messaging for Claude Code instances.
 *
 * This package has three entry points:
 *   - client.ts  -- Local stdio shim (spawned by Claude Code on each PC)
 *                   Detects local context, spawns ssh to the remote server,
 *                   forwards stdio. Required when broker is hosted remotely.
 *   - server.ts  -- MCP server (one per session, runs on the host where the
 *                   broker lives, typically reached via ssh stdio).
 *   - broker.ts  -- Shared broker daemon (one per machine, HTTP+SQLite).
 *
 * See README.md for setup and usage.
 */

export { }; // module marker
