#!/usr/bin/env bash
# shellcheck disable=SC2034  # variables here are read by the files that source this one
# Simulated single server under a temp dir, for tests and the demo. Source this file.
#   sim_init            create SIM_ROOT, shims on PATH, ship.conf, smoke.txt
#   sim_release V       echo path of the demo tarball for version V (builds them on first use)
# Everything is local: the "service" is the demo app run as a child process.
SIM_KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIP="$SIM_KIT/bin/ship"

sim_mixed() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }

sim_symlinks_work() {
  local d; d="$(mktemp -d)"; ln -s "$d" "$d/l" 2>/dev/null; [[ -L "$d/l" ]] && { rm -rf "$d"; return 0; }; rm -rf "$d"; return 1
}

sim_init() {
  SIM_ROOT="$(sim_mixed "$(mktemp -d)")"
  export SHIP_ROOT="$SIM_ROOT"
  export SIM_PORT=$((20000 + RANDOM % 20000))
  export SIM_DB="$SIM_ROOT/shared/data/app.sqlite"
  mkdir -p "$SIM_ROOT/shared/data"
  local shims="$SIM_KIT/sim/shims"
  if sim_symlinks_work; then SIM_PATH="$shims"; SIM_LINKMODE=real; else SIM_PATH="$shims:$SIM_KIT/sim/shims-symlink"; SIM_LINKMODE=emulated; fi
  export PATH="$SIM_PATH:$PATH"
  cat >"$SIM_ROOT/ship.conf" <<CONF
SERVICE=demo-app
HEALTH_URL=http://127.0.0.1:$SIM_PORT/health
HEALTH_TIMEOUT=8
HEALTH_INTERVAL=0.3
DB_PATH=$SIM_DB
MIGRATE_CMD='node migrate.js'
SMOKE_FILE=$SIM_ROOT/smoke.txt
CONF
  cat >"$SIM_ROOT/smoke.txt" <<SMOKE
# METHOD PATH STATUS [| body contains [| request body]]
GET /health 200 | "status":"ok"
GET /items 200 | first item
SMOKE
}

sim_cleanup() {
  [[ -n "${SIM_ROOT:-}" ]] || return 0
  SHIP_ROOT="$SIM_ROOT" systemctl stop demo-app >/dev/null 2>&1 || true
  rm -rf "$SIM_ROOT"
}

sim_release() { # VERSION
  local dist="${SIM_DIST:-$SIM_KIT/demo/dist}"
  [[ -d "$dist" ]] || bash "$SIM_KIT/demo/make-releases.sh" "$dist" >/dev/null
  ls "$dist"/demo-"$1"-*.tar.gz
}
