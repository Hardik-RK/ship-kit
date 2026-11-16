# Design notes

Decisions, in the order a reader is likely to question them. Each says what was chosen, what it costs, and what would change the answer.

## Scope

One Linux server, one app, one file database. That constraint is what lets the tools be small and the safety story short. Nothing here tries to be a platform.

## Release artifact: tarball + sidecar checksum + manifest

- **Immutable directories, one symlink.** A release is unpacked once into `releases/<version>-<sha7>/` and never edited. `current` is a symlink, and "deploy" and "rollback" are the same operation: repoint it. The switch is `ln -sfn target current.new && mv -T current.new current`, a single `rename(2)`, so there is no instant at which `current` is missing or half-written.
- **Unpack to `.partial.<pid>`, then rename.** A deploy interrupted during extraction leaves a hidden directory, never a release that looks complete. A `.ship-complete` marker is written last inside it; only directories with the marker are reused.
- **Manifest** (`MANIFEST.json`: name, version, git sha, `git_dirty`, `schema_version`, `built_at`). The version is what `/health` must report after the deploy, which turns "something answered on port 8080" into "the new code answered". The git sha is part of the release id so two builds with the same version number cannot collide. `schema_version` (highest numeric migration prefix) is the contract for "does this release need a migration": migration runs only when it differs from the current release's value. A release that changes the schema without bumping `schema_version` will not get migrated. That is a deliberate, documented coupling to keep the tool free of migration-framework knowledge.
- **Checksum is a sidecar file**, the format `sha256sum -c` understands. It catches corruption and wrong files. It does not authenticate: an attacker who can replace the tarball can replace the sidecar. Signing (minisign/cosign) is the obvious next step and intentionally left out to keep "copy a script" as the install story.
- **Path check before extraction**: absolute or `..` entries are refused outright rather than relying on tar's defaults.

## The deploy script

- **Bash, not a language runtime.** The server needs bash, tar, curl, sha256sum and (sqlite3 or python3) anyway. A single file can be read in ten minutes, which matters when it is the thing that runs as the deploy user.
- **Order of operations is the safety argument.** Everything that can fail cheaply (checksum, manifest, unpack, backup, migration rehearsal, hook) happens *before* the point of no return, and fails with a distinct exit code and no change to the running system. After the point of no return, any failure triggers rollback. The service is stopped only when a migration will run, and only after the rehearsal passed.
- **Rehearsal on a copy of the verified backup**, not of the live file. Copying a live SQLite file can capture a torn write; the backup is already a consistent snapshot. It also means the rehearsal runs on the exact bytes a restore would produce.
- **Backup is always taken** (when a database exists), even without a migration: it is cheap, it feeds the monitor's freshness check, and it is what the rollback restores. A sidecar `.ok` file (sha256, verified time, release id) marks "verified". A backup that fails `integrity_check` or has a different object count from the source is renamed `.bad` and the deploy stops with exit 5. The tool will not deploy without a way back.
- **SQLite tooling.** Backups use SQLite's online backup API via the `sqlite3` CLI (`.backup`) or Python's `Connection.backup` as a fallback. Both take a consistent snapshot while the app keeps writing. `DB_KIND=file` exists for other file databases but is a plain copy and says so.
- **Restore policy is explicit config** (`if-migrated` default). If a migration ran and the new release fails, the old code usually cannot run on the new schema, so the default restores the backup. The cost is losing writes made since the backup; the failed database is kept next to the live one (`app.sqlite.failed-<ts>`) so they can be recovered by hand. `never` is there for teams that do expand/contract migrations; the harness proves `ship` then fails loudly (exit 8) when the old code cannot start, instead of reporting success.
- **Health means version.** `/health` must return 2xx **and** the manifest version. Otherwise an old process still holding the port, or a reverse proxy serving a cached 200, passes the check. If the unit reports `failed`, the wait ends early instead of burning the whole timeout.
- **Smoke checks are a file of one-line requests**, not a scripting language. Easy to audit, hard to turn into a second application.
- **Locking uses `mkdir`**, not `flock`: atomic on every filesystem, no dependency, works under Git Bash. The lock directory holds the owner pid; a dead owner is detected with `kill -0` and the lock reclaimed with a warning. Limitation: pid reuse could in theory make a stale lock look alive (the failure mode is a refused deploy, which is the safe direction).
- **Dry run does the read-only work for real** (checksum, manifest, lock check) so it can fail for real reasons, and prints the rest. A test snapshots the file tree and the DB hash before and after.
- **Structured logs are logfmt**: greppable, parseable, no dependency, readable raw.
- **Exit codes are an interface.** Distinguishing 5, 6, 7 and 8 lets a CI job or a human know immediately whether the system is untouched (4/5/6), reverted (7), or needs hands (8).

### Things deliberately not done

- No zero-downtime switch. With a schema change the service is stopped for the migration; without one it is a restart.
- No remote execution. `ship` runs on the server; getting a tarball there is `scp`/`rsync`/CI's job. That keeps credentials for the server out of the tool.
- No notification from `ship` itself. Outcomes are exit codes and logs; the monitor is the notifier.
- No parsing of nested JSON in bash. Manifest and health fields are flat strings/numbers read with `sed`. A real JSON parser would add a dependency to the smallest piece of the system.

## Test strategy for the bash scripts

The development machine is Windows, the target is Linux, and neither systemd nor a container runtime was available locally. So the harness fakes only the two things it must:

- `systemctl` (shim) starts the real demo app from whatever `current` points to and tracks the pid. This exercises the interesting parts (does the new code start, does health turn green, does the old one come back) with real processes and real ports.
- On Windows only, `ln -sfn`/`readlink` write and read a pointer file because unprivileged Git Bash cannot create symlinks. `ship` therefore uses only `ln -sfn`, `readlink` and `mv -T` for the pointer and never tests with `[ -L ]`, so the same script runs against both.

What this proves: control flow, ordering, exit codes, backup/restore correctness, lock behaviour, dry-run purity, idempotence. What it cannot prove: real systemd semantics (restart policies, `ExecStartPre`, cgroup kills), and real symlink behaviour on this machine (CI covers Linux). The test for the "backup that fails integrity_check" uses a wrapper `sqlite3` that lies about `*.bak` files, plus a separate test that corrupts the source DB for real.

## The monitor

- **TypeScript, zero runtime dependencies, runs `.ts` directly.** Node 22.13+ strips types natively (`--experimental-strip-types`; no flag needed on newer versions). That means `erasableSyntaxOnly`: no enums, namespaces or parameter properties; imports carry `.ts` extensions. A normal `tsc` build (`rewriteRelativeImportExtensions`) produces plain JS for anyone who prefers it. `typescript` and `@types/node` are dev dependencies only.
- **Config: a small YAML subset or JSON, validated by a hand-written engine.** A full YAML parser would be the first real dependency. The subset (mappings, lists, scalars, inline `[]`/`{}`, comments) covers monitoring configs; anchors, tags and block scalars are rejected with a clear message rather than misparsed. The validator rejects unknown keys (the most common config bug is a silent typo), reports all errors at once with paths, and the published JSON Schema is *generated from the same tables*, with a test that fails if the committed file drifts.
- **Checks never throw.** A check that crashes is reported as `crit: check crashed: ...`. A silent pass on error is the worst monitoring bug.
- **Everything with side effects is injectable** (clock, `statfs`, process exec), so the alert state machine and the expiry/age/rate arithmetic run under a fake clock and the I/O checks run against local servers.
- **Alerting is a pure function** `evaluate(state, results, now, config) -> {state, alerts}`.
  - *Confirmation counts* give flap damping at the cheapest level: nobody is alerted for one failed probe.
  - *"Owed" notification* is the single rule that drives sending: a confirmed status that has not been announced is owed. De-duplication, recovery and retry-after-failed-delivery are all that one rule (a failed delivery just restores the old `lastNotifiedStatus`, so the alert is owed again).
  - *Reminders* every `repeatMinutes`; recovery only if the problem was announced.
  - *Flap detection* is separate from confirmation: a check that keeps changing *confirmed* state (e.g. a flaky dependency with a 3-minute cycle) triggers one notice, then silence, then one "stable" notice.
- **State is a JSON file written atomically** (temp + rename) so `--once` under cron remembers history, and a crash mid-write cannot corrupt it. Unreadable state means start clean rather than refuse to monitor.
- **Dry-run semantics:** it assumes empty history and `failAfter=1`, and never reads or writes state. The purpose is to show every message the current readings *could* produce, not to predict the next cron run. `self-test` adds one synthetic critical so the format of each notifier is visible even when everything is healthy.
- **Disk uses `fs.statfs`** (no `df` parsing, portable) with df's own arithmetic (`used / (used + avail)`); inode use is checked in the same result because a full inode table with free space is a classic outage.
- **TLS expiry** connects with verification off, to read the certificate even when it is already invalid, and reports days against the injected clock. `requireTrusted` adds the chain/hostname check for people who want it.
- **Log error rate** reads only the tail (default 2 MB), finds the first ISO-8601 timestamp in each line (works for plain, logfmt and JSON logs), and attributes continuation lines to the preceding timestamp so stack traces count as one event's lines in the window.
- **Notifiers.** Webhook posts both `text` and `content` so Slack-style and Discord-style endpoints both work with no adapter. Telegram reads the token from an environment variable (config files get committed). SMTP is a ~100-line client: EHLO, STARTTLS, AUTH PLAIN, dot-stuffing; it refuses to send credentials unless the connection is encrypted. Delivery succeeds if *any* notifier accepts, errors from the others are reported.
- **Status page** is a JSON file rewritten each run and, in watch mode, an optional read-only listener bound to localhost by default.

## Known sharp edges

- The monitor's STARTTLS path is tested against a local fake server with a self-signed certificate, not a real mail provider. Treat real-provider SMTP as unverified until you send yourself a test.
- Telegram and webhook are tested against local HTTP servers that mimic the request shape, not the live services.
- `lograte` assumes timestamps within the log lines; logs without them are ignored line by line.
- Pid-based lock staleness and `kill -0` behave differently in containers with separate pid namespaces. Run `ship` from the host or the same namespace as any previous run.
