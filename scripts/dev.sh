#!/usr/bin/env bash
# The dev stack, session-independent — kill/relaunch it cleanly, and check it isn't serving stale.
#
#   scripts/dev.sh restart   # kill any running stack (by port AND pattern), relaunch fresh, wait
#   scripts/dev.sh status    # is the SERVED bundle current, or stale?
#
# Why this exists: a long-lived `vite`/`nest --watch` serves a STALE module graph after a git
# checkout/merge (new inodes the watcher misses) while still answering 200. `restart` makes the fix
# one reliable command; `status` makes the staleness a machine-checkable fact instead of an eyeball.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Node on PATH even in a non-interactive shell (fnm), so this works from pnpm or a bare shell.
export PATH="$HOME/.local/share/fnm:$PATH"
if command -v fnm >/dev/null 2>&1; then eval "$(fnm env 2>/dev/null)"; (cd "$ROOT" && fnm use >/dev/null 2>&1) || true; fi

WEB_URL="http://localhost:12101"
API_URL="http://localhost:3000/api/health"

# --- process / port helpers -------------------------------------------------------------------
pids_on_port() { ss -ltnHp 2>/dev/null | grep -E ":$1 " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u; }
port_busy() { [ -n "$(pids_on_port "$1")" ]; }
# This process and its ancestors — the invocation chain we must NEVER signal. `pgrep -f` matches the
# whole command line, so the very shell that launched us can match a pattern string (e.g. this
# script's own arguments) and we'd otherwise kill ourselves.
_ancestors() {
  local p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do echo "$p"; p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"; done
}
# The stack's own processes — matched by pattern and by port, with the invocation chain excluded.
dev_pids() {
  local protect; protect=" $(_ancestors | tr '\n' ' ') "
  {
    pgrep -f 'pnpm -r --parallel dev' 2>/dev/null
    pgrep -f 'vite/bin/vite' 2>/dev/null
    pgrep -f 'nest start --watch' 2>/dev/null
    pgrep -f 'apps/api/dist/main' 2>/dev/null
    pids_on_port 12101
    pids_on_port 3000
  } | sort -un | while read -r p; do
    case "$protect" in *" $p "*) ;; *) echo "$p" ;; esac
  done
}
# Signal a pid and all its descendants (children get reparented on a bare kill, and would orphan).
kill_tree() {
  local pid=$1 sig=$2 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child" "$sig"; done
  kill "-$sig" "$pid" 2>/dev/null || true
}

kill_stack() {
  local pids; pids="$(dev_pids)"
  if [ -z "$pids" ]; then echo "  nothing running"; return 0; fi
  echo "  stopping: $(echo "$pids" | tr '\n' ' ')"
  for p in $pids; do kill_tree "$p" TERM; done
  for _ in $(seq 1 20); do
    [ -z "$(dev_pids)" ] && ! port_busy 12101 && ! port_busy 3000 && { echo "  stopped; ports free"; return 0; }
    sleep 0.5
    for p in $(dev_pids); do kill_tree "$p" KILL; done
  done
  echo "  WARNING: something survived: $(dev_pids | tr '\n' ' ')" >&2; return 1
}

relaunch() {
  local log="${RANKATI_DEV_LOG:-${TMPDIR:-/tmp}/rankati-dev.log}"
  : > "$log"
  # setsid → its own session, so it outlives this shell and isn't in our process group.
  setsid bash -c "cd '$ROOT' && exec pnpm dev" >"$log" 2>&1 < /dev/null &
  echo "  relaunched (session-independent); log: $log"
}

wait_serving() {
  echo "  waiting for both to serve…"
  for _ in $(seq 1 60); do
    local web api
    web="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/" 2>/dev/null || true)"
    api="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL" 2>/dev/null || true)"
    [ "$web" = "200" ] && [ "$api" = "200" ] && { echo "  web 200, api 200 — up"; return 0; }
    sleep 1
  done
  echo "  TIMED OUT waiting for web/api" >&2; return 1
}

# --- the served-vs-on-disk version, for `status` --------------------------------------------------
banner_re='v[0-9]+\.[0-9]+\.[0-9]+ — [A-Za-z .]+'
disk_banner()   { grep -oE "$banner_re" "$ROOT/apps/web/src/App.tsx" | head -1; }
served_banner() { curl -s "$WEB_URL/src/App.tsx" 2>/dev/null | grep -oE "$banner_re" | head -1; }

cmd_restart() {
  echo "==> stopping any running dev stack"
  kill_stack
  echo "==> relaunching"
  relaunch
  wait_serving || return 1
  echo "==> verify served content matches on-disk"
  cmd_status
}

cmd_status() {
  local disk served version
  version="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '?')"
  disk="$(disk_banner)"
  served="$(served_banner)"
  if [ -z "$served" ]; then
    echo "NOT SERVING — nothing on :12101. Run: scripts/dev.sh restart"
    return 2
  fi
  echo "  package.json: $version"
  echo "  on-disk banner: $disk"
  echo "  served banner:  $served"
  if [ "$served" = "$disk" ]; then
    echo "FRESH — the dev server is serving the current on-disk version."
    return 0
  fi
  echo "STALE — served != on-disk. Run: scripts/dev.sh restart"
  return 1
}

case "${1:-}" in
  restart) cmd_restart ;;
  status)  cmd_status ;;
  *) echo "usage: $0 {restart|status}" >&2; exit 2 ;;
esac
