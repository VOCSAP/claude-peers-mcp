#!/bin/bash
# claude-peers SessionEnd hook -- v0.3.1.
# Marks the peer dormant via POST /disconnect-by-cli-pid.
# Reads env: CLAUDE_PEERS_BROKER_URL (required), CLAUDE_PEERS_BROKER_TOKEN (optional).
# Always exits 0. Failure modes (broker unreachable, missing env) fall through to the
# broker-side sweep heartbeat safety net.

set +e

broker_url="${CLAUDE_PEERS_BROKER_URL:-}"
if [ -z "$broker_url" ]; then
  exit 0
fi

# Drain stdin so Claude Code doesn't block on the pipe even though we don't parse it.
# (The session JSON contains session_id but we send it as informational only.)
input=""
if [ ! -t 0 ]; then
  input=$(cat 2>/dev/null || true)
fi
session_id=""
if [ -n "$input" ]; then
  session_id=$(printf '%s' "$input" | sed -nE 's/.*"session_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1)
fi

host=$(hostname)
# Allow env override for testing on Windows (git-bash $PPID is unreliable there).
claude_cli_pid="${CLAUDE_PEERS_CLI_PID:-$PPID}"
session_json_value="null"
if [ -n "$session_id" ]; then
  # Paranoid escape for any quotes/backslashes in session_id.
  esc=$(printf '%s' "$session_id" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  session_json_value="\"$esc\""
fi
body=$(printf '{"host":"%s","claude_cli_pid":%d,"claude_session_id":%s}' "$host" "$claude_cli_pid" "$session_json_value")

curl_args=(--max-time 2 -s -o /dev/null -X POST -H "Content-Type: application/json")
if [ -n "${CLAUDE_PEERS_BROKER_TOKEN:-}" ]; then
  curl_args+=(-H "Authorization: Bearer $CLAUDE_PEERS_BROKER_TOKEN")
fi
curl_args+=(-d "$body" "$broker_url/disconnect-by-cli-pid")

curl "${curl_args[@]}" 2>/dev/null || true

exit 0
