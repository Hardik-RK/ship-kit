#!/usr/bin/env bash
# Harness tests for bin/ship and bin/ship-build against a simulated server (see sim/).
#   bash test/ship.test.sh            run everything
#   bash test/ship.test.sh NAME...    run only tests whose function name contains NAME
# Each test gets a fresh simulated root, a fresh port and a fresh demo "service".
# What is real: the bash scripts, tar, sha256sum, sqlite3, curl, the demo app process, the filesystem.
# What is faked: systemctl and caddy (sim/shims), and on Windows the `current` symlink (sim/shims-symlink).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../sim/sim.sh
source "$HERE/../sim/sim.sh"
export SIM_DIST="${TMPDIR:-/tmp}/ship-kit-dist.$$"
bash "$SIM_KIT/demo/make-releases.sh" "$SIM_DIST" >/dev/null
trap 'rm -rf "$SIM_DIST"' EXIT

OUT="" RC=0
ship() { OUT="$("$SHIP" "$@" 2>&1)"; RC=$?; }
fail() { echo "    ASSERT FAILED: $*" >&2; echo "    --- last output ---" >&2; echo "$OUT" | cut -c1-240 | tail -n 15 >&2; exit 1; }
assert_rc() { [[ "$RC" == "$1" ]] || fail "exit code: want $1, got $RC"; }
assert_has() { [[ "$OUT" == *"$1"* ]] || fail "output lacks: $1"; }
assert_lacks() { [[ "$OUT" != *"$1"* ]] || fail "output unexpectedly has: $1"; }
assert_eq() { [[ "$1" == "$2" ]] || fail "${3:-values differ}: want '$2', got '$1'"; }
assert_file() { [[ -e "$1" ]] || fail "missing: $1"; }
assert_nofile() { [[ ! -e "$1" ]] || fail "should not exist: $1"; }

live_version() { curl -fsS --max-time 3 "http://127.0.0.1:$SIM_PORT/health" 2>/dev/null | sed -nE 's/.*"version":"([^"]*)".*/\1/p'; }
current_id() { basename "$(readlink "$SIM_ROOT/current" 2>/dev/null)"; }
db_items() { sqlite3 "$SIM_DB" "select group_concat(name,',') from items" 2>&1; }
db_state() { sqlite3 "$SIM_DB" "select name from sqlite_master where type='table' order by 1" | tr '\n' ','; }
deploy_ok() { ship deploy "$(sim_release "$1")"; assert_rc 0; assert_eq "$(live_version)" "$1" "live version after deploying $1"; }
set_conf() { echo "$1" >>"$SIM_ROOT/ship.conf"; }
tree_snapshot() { (cd "$SIM_ROOT" && find . -path ./sim-svc -prune -o -print | sort); }
post_item() { curl -fsS -XPOST "http://127.0.0.1:$SIM_PORT/items" -d "{\"name\":\"$1\"}" >/dev/null; }
build_extra() { # VERSION -> path of a same-schema release built from the demo app
  local d; d="$(mktemp -d)"; cp -R "$SIM_KIT/demo/app/." "$d/"
  "$SIM_KIT/bin/ship-build" --name demo --version "$1" --src "$d" --out "$SIM_ROOT/extra" --sha "abcdef${1//./}" >/dev/null
  rm -rf "$d"; ls "$SIM_ROOT"/extra/demo-"$1"-*.tar.gz
}

# ---------------------------------------------------------------- success paths
t_deploy_first_then_upgrade_keeps_data() {
  deploy_ok 1.0.0
  assert_has "database does not exist yet"
  post_item kept
  deploy_ok 1.1.0
  assert_has "verified backup written"; assert_has "migration succeeded on the copy"
  assert_has "applying 002_notes.sql"; assert_has "DEPLOY OK"
  assert_eq "$(db_items)" "first item,kept" "data survives an upgrade"
  ls "$SIM_ROOT"/shared/backups/*.bak.ok >/dev/null || fail "no verified-backup marker"
}
t_redeploy_same_release_is_idempotent() {
  deploy_ok 1.0.0; deploy_ok 1.1.0
  n_before=$(ls "$SIM_ROOT/shared/backups" | wc -l)
  ship deploy "$(sim_release 1.1.0)"; assert_rc 0; assert_has "already live"
  assert_eq "$(ls "$SIM_ROOT/shared/backups" | wc -l)" "$n_before" "no new backup for a no-op"
  ship deploy "$(sim_release 1.1.0)" --force; assert_rc 0; assert_has "DEPLOY OK"
}
t_smoke_checks_run_after_health() {
  deploy_ok 1.0.0
  assert_has 'check="GET /items"'; assert_has 'check="GET /health"'
}
t_prunes_old_releases_and_backups() {
  set_conf "KEEP_RELEASES=2"; set_conf "BACKUP_KEEP=2"
  for v in 1.0.0 1.1.0; do deploy_ok "$v"; done
  for v in 2.0.0 2.1.0 2.2.0; do ship deploy "$(build_extra "$v")"; assert_rc 0; done
  assert_eq "$(ls "$SIM_ROOT/releases" | wc -l | tr -d ' ')" "2" "releases kept (current + previous)"
  assert_eq "$(ls "$SIM_ROOT/shared/backups"/*.bak | wc -l | tr -d ' ')" "2" "backups kept"
  assert_has "removed old release"
}
t_python_db_tool_fallback() {
  if ! { command -v python3 >/dev/null 2>&1 && python3 -c 'import sqlite3' 2>/dev/null; } && ! command -v python >/dev/null 2>&1; then
    echo "    (no python on this machine, nothing to test)"; return 0
  fi
  export SHIP_DB_TOOL=python
  deploy_ok 1.0.0; deploy_ok 1.1.0; assert_has "verified backup written"
}

# ---------------------------------------------------------------- artifact verification
t_checksum_mismatch_is_refused() {
  deploy_ok 1.0.0
  cp "$(sim_release 1.1.0)" "$SIM_ROOT/tampered.tar.gz"
  cp "$(sim_release 1.1.0).sha256" "$SIM_ROOT/tampered.tar.gz.sha256"
  printf 'x' >>"$SIM_ROOT/tampered.tar.gz"
  ship deploy "$SIM_ROOT/tampered.tar.gz"; assert_rc 4; assert_has "CHECKSUM MISMATCH"
  assert_eq "$(live_version)" "1.0.0"; assert_nofile "$SIM_ROOT/releases/1.1.0-34fcc21"
  assert_eq "$(ls "$SIM_ROOT/shared/backups" 2>/dev/null | wc -l | tr -d ' ')" "0" "no backup attempted"
}
t_missing_checksum_file_is_refused() {
  cp "$(sim_release 1.0.0)" "$SIM_ROOT/nosum.tar.gz"
  ship deploy "$SIM_ROOT/nosum.tar.gz"; assert_rc 4; assert_has "checksum file missing"
}
t_archive_with_parent_paths_is_refused() {
  d="$(mktemp -d)"; echo '{"name":"x","version":"9.9.9","git_sha":"abcdef1","schema_version":1}' >"$d/MANIFEST.json"; echo hi >"$d/evil"
  tar --force-local -czf "$SIM_ROOT/evil.tar.gz" -C "$d" --transform 's,^MANIFEST.json$,./MANIFEST.json,;s,^evil$,../evil,' MANIFEST.json evil
  (cd "$SIM_ROOT" && sha256sum evil.tar.gz >evil.tar.gz.sha256)
  ship deploy "$SIM_ROOT/evil.tar.gz"; assert_rc 4; assert_has "absolute or parent-relative"
  assert_nofile "$SIM_ROOT/releases"
}
t_verify_command() {
  ship verify "$(sim_release 1.1.0)"; assert_rc 0; assert_has 'schema_version="2"'
}
t_build_writes_manifest_and_checksum() {
  d="$(mktemp -d)"; mkdir "$d/migrations"; : >"$d/migrations/007_a.sql"; : >"$d/migrations/012_b.sql"; echo x >"$d/app.txt"
  OUT="$("$SIM_KIT/bin/ship-build" --name t --version 1.2.3 --src "$d" --out "$d/out" --sha 0123456789abcdef 2>&1)"; RC=$?; assert_rc 0
  f="$d/out/t-1.2.3-0123456.tar.gz"; assert_file "$f"
  (cd "$d/out" && sha256sum -c "t-1.2.3-0123456.tar.gz.sha256" >/dev/null) || fail "sha256 file does not verify"
  m="$(tar --force-local -xzOf "$f" ./MANIFEST.json)"
  [[ "$m" == *'"schema_version": 12'* && "$m" == *'"version": "1.2.3"'* && "$m" == *'"git_sha": "0123456789abcdef"'* ]] || fail "manifest wrong: $m"
  OUT="$("$SIM_KIT/bin/ship-build" --name t --version "../bad" --src "$d" --out "$d/out" --sha 0123456789abcdef 2>&1)"; RC=$?; assert_rc 2
}

# ---------------------------------------------------------------- failures before the switch
t_backup_that_fails_integrity_check_aborts() {
  deploy_ok 1.0.0
  real_sqlite="$(command -v sqlite3)"
  cat >"$SIM_ROOT/lying-sqlite3" <<LIE
#!/usr/bin/env bash
# pretends any *.bak file is corrupt
if [[ "\$*" == *integrity_check* && "\$1" == *.bak ]]; then echo "*** in database main ***"; echo "Page 4: btree page is corrupt"; exit 0; fi
exec "$real_sqlite" "\$@"
LIE
  chmod +x "$SIM_ROOT/lying-sqlite3"
  export SHIP_SQLITE3="$SIM_ROOT/lying-sqlite3"
  before="$(db_items)"
  ship deploy "$(sim_release 1.1.0)"; assert_rc 5; assert_has "failed integrity_check"
  assert_eq "$(live_version)" "1.0.0"; assert_eq "$(current_id)" "1.0.0-d9da58e"; assert_eq "$(db_items)" "$before"
  ls "$SIM_ROOT"/shared/backups/*.bad >/dev/null || fail "bad backup should be quarantined as .bad"
  assert_nofile "$SIM_ROOT/releases/1.1.0-34fcc21"
}
t_corrupt_source_database_aborts() {
  deploy_ok 1.0.0
  "$SIM_KIT/sim/shims/systemctl" stop demo-app
  head -c 8192 /dev/urandom >"$SIM_DB"; rm -f "$SIM_DB-wal" "$SIM_DB-shm"
  ship deploy "$(sim_release 1.1.0)"; assert_rc 5; assert_has "no verified backup"
  assert_eq "$(current_id)" "1.0.0-d9da58e" "nothing switched"
}
t_migration_failure_on_copy_leaves_everything_untouched() {
  deploy_ok 1.0.0; deploy_ok 1.1.0
  before="$(db_state)|$(db_items)"
  ship deploy "$(sim_release 1.3.0)"; assert_rc 6; assert_has "migration FAILED on the copy"
  assert_eq "$(live_version)" "1.1.0" "old release kept serving, never stopped"
  assert_eq "$(current_id)" "1.1.0-34fcc21"; assert_eq "$(db_state)|$(db_items)" "$before"
  assert_nofile "$SIM_ROOT/releases/1.3.0-aad56a0"
}
t_pre_switch_hook_failure_aborts() {
  deploy_ok 1.0.0
  echo "INVALID" >"$SIM_ROOT/Caddyfile"
  set_conf "PRE_SWITCH_HOOK='caddy validate --config $SIM_ROOT/Caddyfile'"
  ship deploy "$(sim_release 1.1.0)"; assert_rc 6; assert_has "pre-switch hook failed"
  assert_eq "$(current_id)" "1.0.0-d9da58e"; assert_eq "$(live_version)" "1.0.0"
  echo "site {}" >"$SIM_ROOT/Caddyfile"
  deploy_ok 1.1.0
}

# ---------------------------------------------------------------- failures after the switch: auto-rollback
t_bad_release_rolls_back_and_restores_db() {
  deploy_ok 1.0.0; deploy_ok 1.1.0
  post_item before-bad-deploy
  ship deploy "$(sim_release 1.2.0)"; assert_rc 7
  assert_has "ROLLING BACK"; assert_has "database restored from backup"; assert_has "previous release is serving again"
  assert_eq "$(live_version)" "1.1.0"; assert_eq "$(current_id)" "1.1.0-34fcc21"
  assert_eq "$(db_items)" "first item,before-bad-deploy" "data written before the deploy is intact"
  case "$(db_state)" in *items_v2*) fail "bad migration still applied" ;; esac
  ls "$SIM_ROOT"/shared/data/app.sqlite.failed-* >/dev/null || fail "failed DB not kept for inspection"
}
t_unhealthy_release_rolls_back_without_touching_db() {
  deploy_ok 1.0.0; deploy_ok 1.1.0
  ship deploy "$(sim_release 1.4.0)"; assert_rc 7
  assert_has "ROLLING BACK"; assert_lacks "database restored"; assert_lacks "database NOT restored"
  assert_eq "$(live_version)" "1.1.0"; assert_eq "$(current_id)" "1.1.0-34fcc21"
  if compgen -G "$SIM_ROOT/shared/data/*.failed-*" >/dev/null; then fail "a DB swap happened"; fi
}
t_rollback_without_db_restore_after_migration_cannot_serve() {
  # ROLLBACK_RESTORE_DB=never: the old code meets the migrated schema and cannot start.
  # ship must say so and exit 8 instead of pretending. This is what the restore policy prevents.
  deploy_ok 1.0.0; deploy_ok 1.1.0
  set_conf "ROLLBACK_RESTORE_DB=never"
  ship deploy "$(sim_release 1.2.0)"; assert_rc 8
  assert_has "database NOT restored"; assert_has "ROLLBACK FAILED"
  case "$(db_state)" in *items_v2*) ;; *) fail "expected the migrated schema to remain" ;; esac
}
t_smoke_failure_triggers_rollback() {
  deploy_ok 1.0.0
  echo 'GET /items 200 | text-that-is-not-there' >"$SIM_ROOT/smoke.txt"
  ship deploy "$(sim_release 1.1.0)"; assert_rc 7; assert_has "body missing expected text"; assert_has "smoke checks failed"
  assert_eq "$(live_version)" "1.0.0"
}
t_live_migration_failure_restores_and_rolls_back() {
  deploy_ok 1.0.0
  # passes on the preflight copy, fails on the live database: the nasty case
  set_conf "MIGRATE_CMD='case \"\$SHIP_DB_PATH\" in *app.sqlite) echo live-failure >&2; exit 1;; esac; node migrate.js'"
  ship deploy "$(sim_release 1.1.0)"; assert_rc 7
  assert_has "live migration failed"; assert_has "database restored from backup"
  assert_eq "$(live_version)" "1.0.0"
}
t_first_deploy_failure_cannot_roll_back_and_says_so() {
  ship deploy "$(sim_release 1.4.0)"; assert_rc 8
  assert_has "no previous release to return to"; assert_has "ROLLBACK FAILED"
}

# ---------------------------------------------------------------- locking and dry-run
t_concurrent_deploy_is_refused() {
  deploy_ok 1.0.0
  ( "$SHIP" deploy "$(sim_release 1.1.0)" >"$SIM_ROOT/first.log" 2>&1; echo $? >"$SIM_ROOT/first.rc" ) &
  bg=$!
  for _ in $(seq 1 100); do [[ -d "$SIM_ROOT/state/lock" ]] && break; sleep 0.05; done
  [[ -d "$SIM_ROOT/state/lock" ]] || fail "first deploy never took the lock"
  ship deploy "$(sim_release 1.1.0)"; assert_rc 3; assert_has "holds the lock"
  wait "$bg"; assert_eq "$(cat "$SIM_ROOT/first.rc")" 0 "first deploy still succeeds"
  assert_eq "$(live_version)" "1.1.0"; assert_nofile "$SIM_ROOT/state/lock"
}
t_stale_lock_is_reclaimed() {
  mkdir -p "$SIM_ROOT/state/lock"; echo 999999 >"$SIM_ROOT/state/lock/pid"
  deploy_ok 1.0.0; assert_has "removing stale lock"
}
t_lock_is_released_after_failure() {
  deploy_ok 1.0.0; ship deploy "$(sim_release 1.3.0)"; assert_rc 6; assert_nofile "$SIM_ROOT/state/lock"
}
t_dry_run_changes_nothing() {
  deploy_ok 1.0.0
  before="$(tree_snapshot)"; sum="$(sha256sum "$SIM_DB" | cut -d' ' -f1)"
  ship deploy "$(sim_release 1.1.0)" --dry-run; assert_rc 0
  assert_has "DRY RUN"; assert_has "would unpack"; assert_has "would take and verify"; assert_has "dry run complete"
  assert_eq "$(tree_snapshot)" "$before" "filesystem identical"; assert_eq "$(live_version)" "1.0.0"
  assert_eq "$(sha256sum "$SIM_DB" | cut -d' ' -f1)" "$sum" "database file identical"
}
t_dry_run_on_empty_root_creates_nothing() {
  before="$(tree_snapshot)"
  ship deploy "$(sim_release 1.0.0)" --dry-run; assert_rc 0
  assert_eq "$(tree_snapshot)" "$before"
}
t_dry_run_still_refuses_bad_checksum_and_held_lock() {
  cp "$(sim_release 1.0.0)" "$SIM_ROOT/t.tar.gz"; cp "$(sim_release 1.0.0).sha256" "$SIM_ROOT/t.tar.gz.sha256"; echo z >>"$SIM_ROOT/t.tar.gz"
  ship deploy "$SIM_ROOT/t.tar.gz" --dry-run; assert_rc 4
  sleep 30 & sp=$!; mkdir -p "$SIM_ROOT/state/lock"; echo "$sp" >"$SIM_ROOT/state/lock/pid"
  ship deploy "$(sim_release 1.0.0)" --dry-run; rc=$RC; kill "$sp" 2>/dev/null; assert_eq "$rc" 3
}

# ---------------------------------------------------------------- rollback and status commands
t_rollback_command_switches_back_and_forth() {
  deploy_ok 1.0.0; deploy_ok 1.1.0
  ship rollback; assert_rc 0; assert_has "ROLLBACK OK"
  assert_eq "$(live_version)" "1.0.0"; assert_eq "$(current_id)" "1.0.0-d9da58e"
  ship rollback; assert_rc 0; assert_eq "$(live_version)" "1.1.0"
}
t_rollback_command_can_restore_a_backup() {
  deploy_ok 1.0.0; deploy_ok 1.1.0
  bak="$(ls "$SIM_ROOT"/shared/backups/*.bak | head -1)"
  post_item after
  ship rollback --restore-db "$bak"; assert_rc 0; assert_has "database restored from backup"
  assert_eq "$(db_items)" "first item" "database is back to the backup's contents"
  assert_eq "$(live_version)" "1.0.0"
}
t_rollback_with_no_previous_is_a_usage_error() {
  deploy_ok 1.0.0; ship rollback; assert_rc 2; assert_has "no previous release"
}
t_rollback_dry_run() {
  deploy_ok 1.0.0; deploy_ok 1.1.0; ship rollback --dry-run; assert_rc 0; assert_eq "$(live_version)" "1.1.0"
}
t_status_reports_state_as_text_and_json() {
  deploy_ok 1.0.0; deploy_ok 1.1.0
  ship status --json; assert_rc 0
  assert_has '"current":"1.1.0-34fcc21"'; assert_has '"previous":"1.0.0-d9da58e"'; assert_has '"health_version":"1.1.0"'; assert_has '"latest_backup_verified":"yes"'
  ship status; assert_rc 0; assert_has "service   : active"
  "$SIM_KIT/sim/shims/systemctl" stop demo-app
  ship status; assert_rc 1; assert_has "health    : down"
}
t_config_errors_exit_2() {
  echo "SERVICE=x" >"$SIM_ROOT/ship.conf"
  ship status; assert_rc 2; assert_has "HEALTH_URL is required"
  ship deploy; assert_rc 2
  ship frobnicate; assert_rc 2
}

# ---------------------------------------------------------------- runner
filter=("$@")
pass=0 failed=0 names=()
mapfile -t names < <(declare -F | awk '{print $3}' | grep '^t_')
for t in "${names[@]}"; do
  if [[ ${#filter[@]} -gt 0 ]]; then m=0; for f in "${filter[@]}"; do [[ "$t" == *"$f"* ]] && m=1; done; (( m )) || continue; fi
  log="$(mktemp)"
  (
    sim_init
    trap sim_cleanup EXIT
    set +e
    "$t"
  ) >"$log" 2>&1
  rc=$?
  if [[ $rc -eq 0 ]]; then pass=$((pass + 1)); printf 'ok     %s\n' "${t#t_}"; else failed=$((failed + 1)); printf 'FAIL   %s\n' "${t#t_}"; sed 's/^/       /' "$log"; fi
  rm -f "$log"
done
echo "-- $pass passed, $failed failed (symlinks: $(sim_symlinks_work && echo real || echo emulated))"
[[ $failed -eq 0 ]]
