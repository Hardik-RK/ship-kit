# ship-kit

Release and monitoring scripts for an app that runs on one Linux server: Node or Python behind systemd and Caddy or nginx, with a SQLite (or other file) database.

`bin/ship` deploys a checksummed tarball with a verified database backup and rolls back by itself if the new release does not come up healthy. `monitor/` is a small TypeScript program that checks HTTP, TLS expiry, disk and inodes, systemd units, backup age and log error rate, and sends de-duplicated alerts. There are no agents, containers or hosted services; installing means copying a script to the server.

## Why

A solo developer on one VPS usually has `git pull && systemctl restart`, which has no way back, or a platform that is too much for one box. The usual failures: the new code does not start and the old code is gone; a migration half-applies and the old code cannot read the schema either; the backup was never verified or stopped running weeks ago; the certificate expired or the disk filled and nobody was told.

ship-kit does the checklist: verify the artifact, take and verify a backup, rehearse the migration on a copy, switch atomically, check health and smoke tests, and go back automatically on failure. The monitor watches the things that rot quietly.

## How a deploy works

![Release flow: build, verify, backup, preflight, switch, health and smoke, automatic rollback; the monitor runs separately](docs/img/release-flow.svg)

Everything before "Switch" leaves the running system untouched. The service is stopped only when `schema_version` changed and `MIGRATE_CMD` is set, and only after the rehearsal on a copy succeeded. Health must report the new version, so an old process still answering `/health` does not count as success.

On failure after the switch, `ship` stops the service, restores the verified backup according to `ROLLBACK_RESTORE_DB` (`if-migrated` by default; the failed database is kept as `app.sqlite.failed-TS`), repoints `current` to the previous release, restarts, and checks that version is healthy. Exit 7 means the deploy failed and you are back where you started. Exit 8 means a person is needed, including a first deploy that fails, where there is nothing to go back to.

## Quick start (no server needed)

Requirements: bash, the `sqlite3` CLI (or Python 3), `curl`, `tar`, `sha256sum`, Node 22.13 or newer. On Windows use Git Bash.

```bash
git clone https://github.com/Hardik-RK/ship-kit && cd ship-kit
bash demo/demo.sh          # good deploy, broken migration, crashing release, auto-rollback
```

`demo/demo.sh` builds five demo releases and runs them in a throwaway directory, with a `systemctl` shim that launches the demo app as a child process. Captured output: [docs/DEMO-TRANSCRIPT.md](docs/DEMO-TRANSCRIPT.md). To do the same by hand:

```bash
bash demo/make-releases.sh /tmp/dist            # 1.0.0, 1.1.0 good; 1.2.0, 1.3.0, 1.4.0 bad in different ways
source sim/sim.sh && sim_init                   # temp server root, shims on PATH, ship.conf written
bin/ship deploy /tmp/dist/demo-1.0.0-*.tar.gz
bin/ship deploy /tmp/dist/demo-1.1.0-*.tar.gz --dry-run   # plan only
bin/ship deploy /tmp/dist/demo-1.1.0-*.tar.gz
bin/ship deploy /tmp/dist/demo-1.2.0-*.tar.gz   # crashes on start: exit 7, DB restored
bin/ship status
sim_cleanup
```

### On a real server

```bash
# on your machine
bin/ship-build --name myapp --version 1.4.2 --src ./build-output --out ./dist   # git sha read from --src
scp dist/myapp-1.4.2-*.tar.gz* deploy@server:/tmp/

# on the server, once: copy bin/ship, create /srv/myapp, write /srv/myapp/ship.conf (examples/ship.conf)
# and a systemd unit with WorkingDirectory=/srv/myapp/current (examples/systemd/myapp.service)
export SHIP_ROOT=/srv/myapp
ship deploy /tmp/myapp-1.4.2-*.tar.gz --dry-run
ship deploy /tmp/myapp-1.4.2-*.tar.gz
```

### Monitor

```bash
npm install                                      # dev tools only (typescript, @types/node); the monitor has no dependencies
node monitor/src/cli.ts validate  --config examples/monitor.yaml
node monitor/src/cli.ts self-test --config examples/monitor.yaml      # runs the checks, prints what it would send, sends nothing
node monitor/src/cli.ts watch --config examples/monitor.yaml --once   # for cron; exit 1 if anything is warn/crit
node monitor/src/cli.ts watch --config examples/monitor.yaml          # long-running, optional status endpoint
# compiled JS: npm run build && node dist/cli.js watch --config examples/monitor.yaml
```

Cron: `* * * * * cd /opt/ship-kit && node monitor/src/cli.ts watch --config /etc/ship/monitor.yaml --once`

## Release layout and commands

```
$SHIP_ROOT/
  releases/<version>-<sha7>/   immutable, one per deploy
  current -> releases/...      symlink, replaced with a single rename(2)
  shared/data, shared/backups  survive releases (the DB and verified backups with a .ok sidecar)
  state/                       lock/, history, previous, ship.log
  ship.conf
```

| Command | Does |
|---|---|
| `ship deploy FILE [--dry-run] [--force]` | The flow above. `--dry-run` verifies the artifact and prints the plan; it creates and changes nothing, and still refuses if the lock is held. `--force` redeploys the release that is already live. |
| `ship rollback [--restore-db BACKUP] [--dry-run]` | Switch to the previous release (`state/previous`), optionally restoring a verified backup first, then wait for its health. Running it again goes forward again. |
| `ship status [--json]` | Current/previous release, service state, live health version, newest backup and whether it is verified. Exit 1 if not healthy. |
| `ship verify FILE` | Checksum, path safety and manifest check only. |
| `ship-build` | `--name --version --src [--out --migrations --sha]` |

Exit codes: `0` ok, `1` unexpected or `status` unhealthy, `2` usage/config, `3` lock held, `4` artifact rejected, `5` no verified backup, `6` preflight failed (migration on the copy or pre-switch hook), `7` failed and rolled back, `8` failed and rollback failed, `9` missing tool.

Logs are one logfmt line per event (`ts=... level=info step=backup msg="..." file=...`) on stdout/stderr and appended to `state/ship.log`.

### ship.conf reference

Sourced as bash (so it is code you own). See [examples/ship.conf](examples/ship.conf).

| Variable | Default | Meaning |
|---|---|---|
| `SERVICE` | required | systemd unit to restart |
| `HEALTH_URL` | required | endpoint returning 2xx JSON; smoke paths resolve against its directory |
| `HEALTH_VERSION_FIELD` | `version` | JSON field that must equal the manifest version |
| `HEALTH_TIMEOUT` / `HEALTH_INTERVAL` | `30` / `1` | seconds to wait / poll interval |
| `SYSTEMCTL` | `systemctl` | command prefix, e.g. `sudo systemctl` |
| `DB_PATH` | empty | database file; empty skips all DB steps |
| `DB_KIND` | `sqlite` | `sqlite` online backup + `integrity_check`; `file` plain copy (only safe if the app is idle) |
| `BACKUP_DIR` / `BACKUP_KEEP` | `$SHIP_ROOT/shared/backups` / `10` | where verified backups go, how many to keep |
| `KEEP_RELEASES` | `5` | releases kept (never the current or previous one) |
| `MIGRATE_CMD` | empty | run inside the new release dir with `SHIP_DB_PATH`; once on a copy, once on the live DB. Only runs when `schema_version` changed |
| `ROLLBACK_RESTORE_DB` | `if-migrated` | `if-migrated`, `always`, `never` |
| `SMOKE_FILE` | empty | one check per line: `METHOD PATH STATUS [\| must-contain [\| request body]]` |
| `PRE_SWITCH_HOOK` / `POST_SUCCESS_HOOK` | empty | commands run in the release dir; the first aborts on failure, the second only warns |

### monitor config reference

One YAML or JSON file; the schema is in [monitor/config.schema.json](monitor/config.schema.json) (generated from the validator's own tables). Unknown keys are errors, so typos are caught. All problems are reported at once.

```yaml
name: demo-app
intervalSeconds: 60
stateFile: /var/lib/ship-monitor/state.json    # needed for --once to remember between runs
statusFile: /var/lib/ship-monitor/status.json
serve: {port: 9100}                            # optional read-only GET /status.json (watch mode)
alerting: {failAfter: 2, recoverAfter: 2, repeatMinutes: 120, flap: {threshold: 4, windowMinutes: 30}}
notifiers: [...]   # webhook | telegram | email
checks: [...]      # http | tls | disk | systemd | backup | lograte
```

| Check | Key options (defaults) | Goes warn/crit when |
|---|---|---|
| `http` | `url`, `expectStatus` (200), `warnLatencyMs`, `critLatencyMs`, `json: {field, equals\|exists}`, `timeoutMs` (5000) | wrong status, timeout, refused, slow, JSON field wrong |
| `tls` | `host`, `port` (443), `warnDays` (21), `critDays` (7), `requireTrusted` (false) | days to expiry at or below thresholds; expired is always crit |
| `disk` | `path`, `warnPercent` (80), `critPercent` (90), `inodeWarnPercent`, `inodeCritPercent` | space **or** inode use above thresholds (df arithmetic) |
| `systemd` | `unit` | anything but `active` (`activating` is warn) |
| `backup` | `dir`, `pattern` (`\.bak$`), `requireMarker`, `warnHours` (26), `critHours` (50) | newest matching file too old, empty, or none. `requireMarker: true` only counts backups with a `.ok` sidecar, which is what `ship` writes after verification |
| `lograte` | `file`, `windowMinutes` (10), `errorPattern`, `warnCount`/`critCount`, `warnRatePercent`/`critRatePercent`, `minLinesForRate` (20) | errors in the time window. Lines need an ISO-8601 timestamp somewhere; continuation lines (stack traces) inherit the previous line's time; no-timezone stamps are read as UTC |
| notifier `webhook` | `url`, `headers` | POSTs JSON with `text` and `content` (Slack/Discord style) plus structured fields |
| notifier `telegram` | `tokenEnv`, `chatId` | token is read from that environment variable, never from the file |
| notifier `email` | `host`, `port` (587), `starttls` (true), `secure`, `user`, `passEnv`, `from`, `to[]`, `insecureTls` | plain SMTP client; refuses to send credentials without TLS |

Alerting rules: a status change is confirmed only after `failAfter`/`recoverAfter` consecutive readings (a single blip alerts nobody); each confirmed status is announced once and repeated only as a reminder every `repeatMinutes`; recovery is sent only if the problem was announced; if a check changes confirmed status `flap.threshold` times in `flap.windowMinutes` it sends one "flapping" notice, goes quiet, then sends one "stable" notice. If **no** notifier accepts an alert, it is retried on the next run.

## Tests

```bash
npm install
npm test                         # monitor unit tests, then the bash harness
npm run test:monitor             # a few seconds
npm run test:ship                # 32 harness tests; slow on Windows Git Bash (process spawn), not timed on Linux
bash test/ship.test.sh dry_run   # only tests whose name contains "dry_run"
npm run typecheck && npm run build
```

- `test/ship.test.sh` runs the real `ship` and `ship-build` with real `tar`, `sha256sum`, `sqlite3` and `curl`, and the demo app as a child process on a random port, in a temp directory per test. `systemctl` and `caddy` are faked (`sim/shims`). On Windows, where Git Bash cannot create symlinks, a pointer-file `ln`/`readlink` shim stands in for `current`.
- Monitor tests use a fake clock for the alert state machine and TLS expiry, local HTTP and HTTPS servers (the HTTPS one needs the `openssl` CLI for a throwaway certificate), and a fake SMTP server.
- CI (`.github/workflows/ci.yml`): shellcheck, the harness on Ubuntu and in a Debian 12 container, typecheck and monitor tests on Node 22 and 24, and the compiled build.

## Limitations

- **Data written between backup and rollback is lost** when the DB is restored (it stays in `app.sqlite.failed-TS`, not merged). For write-heavy apps prefer backward-compatible migrations and `ROLLBACK_RESTORE_DB=never`; `ship` still exits 8 if the old code then cannot start.
- **Migrations stop the service**, so a deploy with a schema change has downtime of about the migration time. No zero-downtime or blue/green. Without a schema change it is a restart.
- **One server is one point of failure.** No failover or off-site backups. Copy `shared/backups` elsewhere (restic, rclone); the monitor can alert on backup age, not location.
- **No release signing yet.** The `.sha256` sidecar travels with the tarball, so it catches corruption and the wrong file, not an attacker who can replace both. Verify the hash out of band. Signing (minisign or cosign) is the next step; see [docs/DESIGN.md](docs/DESIGN.md).
- **A passing health check is not correctness.** It shows the process answers, reports the right version and passes your smoke file.
- **Backups are checked with `integrity_check` and an object-count compare**, not restored into a running app. Restore-test them.
- **`ship.conf` and hooks run as the deploy user.** Protect them like code.
- **systemd is simulated in tests.** `Restart=` policies, `ExecStartPre`, socket activation and cgroup kill behaviour are not exercised.
- **JSON handling is shallow:** the manifest and health response are read with `sed` for flat fields; nested or escaped values are not supported.
- **Linux only** (`readlink -f`, GNU `mv -T`, `ln -sfn`, GNU `tar`). Windows Git Bash is a test convenience.
- **The monitor is not an alert manager.** It runs on the box it watches unless you run it elsewhere. Also point an external uptime check at the public URL.

## Repository layout

```
bin/ship, bin/ship-build   release tools (bash)
monitor/src, monitor/test  the monitor (TypeScript, Node 22+ with type stripping)
demo/                      sample service, migrations, make-releases.sh, demo.sh
sim/                       simulated server: systemctl/caddy shims, symlink shims for Windows
examples/                  ship.conf, smoke.txt, monitor.yaml/json, systemd unit, Caddyfile, sudoers
docs/DESIGN.md             decisions and trade-offs
docs/DEMO-TRANSCRIPT.md    captured output of demo/demo.sh
docs/img/                  diagrams
```

## Licence

MIT, see [LICENSE](LICENSE).
