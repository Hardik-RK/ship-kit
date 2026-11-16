#!/usr/bin/env bash
# Guided demo: a good deploy, a bad migration caught on the copy, and a bad release that is
# rolled back automatically (with the database restored). Runs entirely on this machine:
# the "server" is a temp directory, the "service" is the demo app run as a child process,
# systemctl is a shim (see sim/). Nothing outside the temp directory is touched.
#
#   bash demo/demo.sh            # prints a transcript
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../sim/sim.sh
source "$HERE/../sim/sim.sh"
export SIM_DIST="${TMPDIR:-/tmp}/ship-kit-demo-dist.$$"
bash "$HERE/make-releases.sh" "$SIM_DIST" >/dev/null
sim_init
trap 'sim_cleanup; rm -rf "$SIM_DIST"' EXIT

# Show paths and ports the way they would look on a real box.
tidy() { sed -e "s#$SIM_ROOT#/srv/demo#g" -e "s#$SIM_PORT#8080#g" -e "s#$SIM_DIST#./dist#g"; }
say() { printf '\n# %s\n' "$*"; }
run() {
  local show="$*"
  printf '$ %s\n' "$show" | tidy
  "$@" 2>&1 | tidy
  local rc=${PIPESTATUS[0]}
  printf '[exit %s]\n' "$rc"
  return 0
}
ship() { "$SHIP" "$@"; }

say "The 'server': releases/, current -> a release, shared/ (database + backups), ship.conf"
tidy <"$SIM_ROOT/ship.conf"

say "1. First deploy of 1.0.0 (no database yet, so no backup; the migration creates it)"
run ship deploy "$(sim_release 1.0.0)"

say "Some live data arrives"
curl -fsS -XPOST "http://127.0.0.1:$SIM_PORT/items" -d '{"name":"order #1042"}' | tidy; echo

say "2. A good upgrade to 1.1.0: verified backup, migration rehearsed on a copy, then switch"
run ship deploy "$(sim_release 1.1.0)"

say "3. Dry run of the next release: shows the plan, changes nothing"
run ship deploy "$(sim_release 1.2.0)" --dry-run

say "4. 1.3.0 has a broken migration. The rehearsal on the COPY catches it; live data and service are untouched"
run ship deploy "$(sim_release 1.3.0)"
run ship status

say "5. 1.2.0 migrates fine, then crashes on start. Health never turns green, so ship rolls back by itself:"
say "   it restores the pre-deploy backup and switches 'current' back"
run ship deploy "$(sim_release 1.2.0)"

say "State afterwards: 1.1.0 serving, data intact"
run ship status
curl -fsS "http://127.0.0.1:$SIM_PORT/items" | tidy; echo

say "6. 1.4.0 starts but /health says 503 (no schema change): rolled back, database left alone"
run ship deploy "$(sim_release 1.4.0)"

say "7. Manual rollback to the previous release, then forward again"
run ship rollback
run ship rollback
