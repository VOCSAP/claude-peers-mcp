#!/bin/bash
# claude-peers SessionEnd hook -- v0.3.2.
#
# Workflow:
#   1. GET this host's active peers via POST /list-peers-by-host.
#   2. For each peer, probe its recorded claude_cli_pid liveness locally:
#        - Windows (MINGW/MSYS/CYGWIN): tasklist //FI "PID eq <pid>" //NH | grep -qw <pid>
#        - POSIX (Linux/macOS): kill -0 <pid>
#   3. POST /disconnect by instance_token for every peer whose PID is dead.
#
# This avoids the v0.3.1 limitation where the hook's $PPID was the only
# correlation key (always 1 on Windows because Claude Code detaches the hook,
# making the disconnect a silent no-op there).
#
# Reads env: CLAUDE_PEERS_BROKER_URL (required), CLAUDE_PEERS_BROKER_TOKEN (optional).
# Always exits 0 -- the broker-side heartbeat sweep is the final safety net.

set +e

broker_url="${CLAUDE_PEERS_BROKER_URL:-}"
[ -z "$broker_url" ] && exit 0

# Drain stdin so Claude Code doesn't block on the pipe. The session JSON is
# discarded -- v0.3.2 no longer correlates by claude_session_id.
if [ ! -t 0 ]; then
  cat >/dev/null 2>&1 || true
fi

host=$(hostname)

# Platform detection for the PID liveness check.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) is_windows=1 ;;
  *) is_windows=0 ;;
esac

is_pid_alive() {
  local pid=$1
  # Empty / zero / null are treated as dead candidates so they get cleaned up.
  if [ -z "$pid" ] || [ "$pid" = "0" ] || [ "$pid" = "null" ]; then
    return 1
  fi
  if [ "$is_windows" = "1" ]; then
    # tasklist always exits 0; the discriminator is whether the PID appears
    # word-bounded in the output.
    tasklist //FI "PID eq $pid" //NH 2>/dev/null | grep -qw "$pid"
  else
    kill -0 "$pid" 2>/dev/null
  fi
}

# Shared curl auth headers.
auth_args=()
if [ -n "${CLAUDE_PEERS_BROKER_TOKEN:-}" ]; then
  auth_args=(-H "Authorization: Bearer $CLAUDE_PEERS_BROKER_TOKEN")
fi

# 1. List active peers on this host.
list_body=$(printf '{"host":"%s"}' "$host")
list_resp=$(curl --max-time 2 -s -X POST -H "Content-Type: application/json" \
  "${auth_args[@]}" -d "$list_body" "$broker_url/list-peers-by-host" 2>/dev/null)
[ -z "$list_resp" ] && exit 0

# 2. Parse {peers:[{instance_token,claude_cli_pid},...]} via sed. We split
# adjacent objects with a newline so a per-line regex can extract the fields.
normalized=$(printf '%s' "$list_resp" | sed 's/},{/}\n{/g')

while IFS= read -r obj; do
  [ -z "$obj" ] && continue
  token=$(printf '%s' "$obj" | sed -nE 's/.*"instance_token":[[:space:]]*"([^"]+)".*/\1/p')
  pid=$(printf '%s' "$obj" | sed -nE 's/.*"claude_cli_pid":[[:space:]]*(null|[0-9]+).*/\1/p')
  [ -z "$token" ] && continue
  # 3. Disconnect peers whose recorded PID is dead (or missing).
  if ! is_pid_alive "$pid"; then
    dc_body=$(printf '{"instance_token":"%s"}' "$token")
    curl --max-time 2 -s -o /dev/null -X POST -H "Content-Type: application/json" \
      "${auth_args[@]}" -d "$dc_body" "$broker_url/disconnect" 2>/dev/null
  fi
done <<EOF
$normalized
EOF

exit 0
