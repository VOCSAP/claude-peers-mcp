#!/usr/bin/env bun
/**
 * claude-peers SessionEnd hook -- v0.3.1.
 *
 * Invoked by Claude Code on /exit, session timeout, or disconnect.
 * Reads a JSON payload on stdin (provides session_id), POSTs
 * /disconnect-by-cli-pid to the broker with (hostname(), process.ppid).
 * The CLI parent process (Claude Code) is the same parent as the spawned
 * server.ts, so process.ppid here equals the claude_cli_pid stored on the peer.
 *
 * Always exits 0. Failure modes (broker unreachable, bad JSON, timeout)
 * fall through to the broker-side sweep heartbeat as a safety net.
 */
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { loadConfig, brokerUrl } from "./shared/config.ts";

const TIMEOUT_MS = 2000;

async function main(): Promise<void> {
  let payload: { session_id?: string } = {};
  try {
    const raw = readFileSync(0, "utf-8");
    payload = JSON.parse(raw);
  } catch {
    // empty / non-JSON stdin -- continue with empty payload.
  }

  let config;
  try { config = await loadConfig(); } catch { return; }
  const url = brokerUrl(config);
  if (!url) return;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.broker_token) headers["Authorization"] = `Bearer ${config.broker_token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(`${url}/disconnect-by-cli-pid`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        host: hostname(),
        claude_cli_pid: process.ppid,
        claude_session_id: payload.session_id ?? null,
      }),
      signal: ctrl.signal,
    });
  } catch {
    // broker unreachable, timed out, or non-2xx: fail silent.
  } finally {
    clearTimeout(timer);
  }
}

await main();
process.exit(0);
