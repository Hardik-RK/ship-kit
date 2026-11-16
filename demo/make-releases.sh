#!/usr/bin/env bash
# Build the demo release tarballs into OUT (default demo/dist):
#   1.0.0  good, migration 001
#   1.1.0  good, migrations 001-002
#   1.2.0  BAD: migration 003 applies fine (renames a table), then the service cannot start
#   1.3.0  BAD: migration 003 is broken; the preflight on the copy rejects it
#   1.4.0  BAD: runs but /health answers 503, no schema change (rollback WITHOUT a DB restore)
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/dist}"
rm -rf "$OUT"; mkdir -p "$OUT"
stage() { # VERSION [extra migration] [BUG value]
  local d; d="$(mktemp -d "${TMPDIR:-/tmp}/demo-stage.XXXXXX")"
  cp -R "$HERE/app/." "$d/"
  case "$1" in 1.0.0) rm -f "$d/migrations/002_notes.sql" ;; esac
  [[ -z "${2:-}" ]] || cp "$HERE/extra/$2" "$d/migrations/"
  [[ -z "${3:-}" ]] || printf '%s\n' "$3" >"$d/BUG"
  echo "$d"
}
build() { # VERSION [extra migration] [BUG]
  local d sha; d="$(stage "$@")"
  sha="$(printf 'demo-%s' "$1" | sha1sum | cut -c1-40)"   # stand-in for a git sha
  "$HERE/../bin/ship-build" --name demo --version "$1" --src "$d" --out "$OUT" --sha "$sha" >/dev/null
  rm -rf "$d"
  echo "built demo $1"
}
build 1.0.0
build 1.1.0
build 1.2.0 003_rename_items.sql crash
build 1.3.0 003_broken.sql
build 1.4.0 "" unhealthy
ls -1 "$OUT"
