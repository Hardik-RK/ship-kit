# Demo transcript

Real output of `bash demo/demo.sh` on a Windows machine under Git Bash (simulated `systemctl`, emulated `current` symlink; see README "Testing"). Paths and the port are rewritten to `/srv/demo` and `8080` for readability; everything else is verbatim, including timestamps. Nothing here ran on a real server or under real systemd.

Reading guide: exit 0 = deployed; exit 6 = preflight failed, nothing changed; exit 7 = failed after the switch and automatically rolled back.

```text

# The 'server': releases/, current -> a release, shared/ (database + backups), ship.conf
SERVICE=demo-app
HEALTH_URL=http://127.0.0.1:8080/health
HEALTH_TIMEOUT=8
HEALTH_INTERVAL=0.3
DB_PATH=/srv/demo/shared/data/app.sqlite
MIGRATE_CMD='node migrate.js'
SMOKE_FILE=/srv/demo/smoke.txt

# 1. First deploy of 1.0.0 (no database yet, so no backup; the migration creates it)
$ ship deploy ./dist/demo-1.0.0-d9da58e.tar.gz
ts=2026-11-16T01:22:32Z level=info step=verify msg="checksum ok" sha256="d699b7ecb6777d0150cbc1a62e39315654314271d3994e596d5a176780aaaf55"
ts=2026-11-16T01:22:33Z level=info step=verify msg="manifest ok" name="demo" version="1.0.0" git_sha="d9da58e3621cc7cc8d1a307fdf56d50bf5381d62" schema_version="1"
ts=2026-11-16T01:22:33Z level=info step=plan msg="deploy plan" release="1.0.0-d9da58e" previous="" schema="none->1" migrate="1"
ts=2026-11-16T01:22:34Z level=info step=unpack msg="release unpacked" dir="/srv/demo/releases/1.0.0-d9da58e"
ts=2026-11-16T01:22:34Z level=info step=backup msg="database does not exist yet (first deploy), skipping" db="/srv/demo/shared/data/app.sqlite"
ts=2026-11-16T01:22:34Z level=info step=preflight msg="running migration on a copy of the verified backup"
ts=2026-11-16T01:22:35Z level=info step=preflight msg="migration succeeded on the copy"
ts=2026-11-16T01:22:35Z level=info step=migrate msg="stopping demo-app and migrating the live database"
migrate: applying 001_init.sql
migrate: up to date
ts=2026-11-16T01:22:35Z level=info step=switch msg="current now points at the new release" release="1.0.0-d9da58e"
ts=2026-11-16T01:22:36Z level=info step=health msg="waiting for health" url="http://127.0.0.1:8080/health" version="1.0.0" timeout="8s"
ts=2026-11-16T01:22:37Z level=info step=health msg="healthy" version="1.0.0"
ts=2026-11-16T01:22:37Z level=info step=smoke msg="ok" check="GET /health" status="200"
ts=2026-11-16T01:22:37Z level=info step=smoke msg="ok" check="GET /items" status="200"
ts=2026-11-16T01:22:38Z level=info step=deploy msg="DEPLOY OK" release="1.0.0-d9da58e" version="1.0.0"
[exit 0]

# Some live data arrives
{"id":2,"name":"order #1042"}

# 2. A good upgrade to 1.1.0: verified backup, migration rehearsed on a copy, then switch
$ ship deploy ./dist/demo-1.1.0-34fcc21.tar.gz
ts=2026-11-16T01:22:39Z level=info step=verify msg="checksum ok" sha256="ac7f4163498753fd86ebb3abbb95f8c434ae5b6ee38075987e9307c5c067e5d3"
ts=2026-11-16T01:22:40Z level=info step=verify msg="manifest ok" name="demo" version="1.1.0" git_sha="34fcc21b4af2fea77cdb7a2e8b4069ed9a86ba3c" schema_version="2"
ts=2026-11-16T01:22:41Z level=info step=plan msg="deploy plan" release="1.1.0-34fcc21" previous="1.0.0-d9da58e" schema="1->2" migrate="1"
ts=2026-11-16T01:22:42Z level=info step=unpack msg="release unpacked" dir="/srv/demo/releases/1.1.0-34fcc21"
ts=2026-11-16T01:22:43Z level=info step=backup msg="verified backup written" file="/srv/demo/shared/backups/app.sqlite.20261116T012242Z.pre-1.1.0-34fcc21.bak" bytes="16384"
ts=2026-11-16T01:22:43Z level=info step=preflight msg="running migration on a copy of the verified backup"
ts=2026-11-16T01:22:43Z level=info step=preflight msg="migration succeeded on the copy"
ts=2026-11-16T01:22:44Z level=info step=migrate msg="stopping demo-app and migrating the live database"
migrate: applying 002_notes.sql
migrate: up to date
ts=2026-11-16T01:22:45Z level=info step=switch msg="current now points at the new release" release="1.1.0-34fcc21"
ts=2026-11-16T01:22:45Z level=info step=health msg="waiting for health" url="http://127.0.0.1:8080/health" version="1.1.0" timeout="8s"
ts=2026-11-16T01:22:46Z level=info step=health msg="healthy" version="1.1.0"
ts=2026-11-16T01:22:46Z level=info step=smoke msg="ok" check="GET /health" status="200"
ts=2026-11-16T01:22:47Z level=info step=smoke msg="ok" check="GET /items" status="200"
ts=2026-11-16T01:22:47Z level=info step=deploy msg="DEPLOY OK" release="1.1.0-34fcc21" version="1.1.0"
[exit 0]

# 3. Dry run of the next release: shows the plan, changes nothing
$ ship deploy ./dist/demo-1.2.0-b4f6e82.tar.gz --dry-run
ts=2026-11-16T01:22:48Z level=info step=deploy msg="DRY RUN: nothing will be changed"
ts=2026-11-16T01:22:48Z level=info step=verify msg="checksum ok" sha256="0b3ea01784b1615cf8419d3f946e7a64b38da0c6ed8e51dd429eddb689bdf07e"
ts=2026-11-16T01:22:49Z level=info step=verify msg="manifest ok" name="demo" version="1.2.0" git_sha="b4f6e8209782fb92ca260cfb20bd45a61d0ba809" schema_version="3"
ts=2026-11-16T01:22:50Z level=info step=plan msg="deploy plan" release="1.2.0-b4f6e82" previous="1.1.0-34fcc21" schema="2->3" migrate="1"
ts=2026-11-16T01:22:50Z level=info step=unpack msg="[dry-run] would unpack" dir="/srv/demo/releases/1.2.0-b4f6e82"
ts=2026-11-16T01:22:50Z level=info step=backup msg="[dry-run] would take and verify an online backup" db="/srv/demo/shared/data/app.sqlite"
ts=2026-11-16T01:22:50Z level=info step=preflight msg="[dry-run] would run the migration against a copy of the database"
ts=2026-11-16T01:22:50Z level=info step=switch msg="[dry-run] would (migrate=1: stop service and migrate), switch current -> 1.2.0-b4f6e82, restart demo-app"
ts=2026-11-16T01:22:51Z level=info step=health msg="[dry-run] would wait up to 8s for http://127.0.0.1:8080/health to report version 1.2.0"
ts=2026-11-16T01:22:51Z level=info step=smoke msg="[dry-run] would run smoke checks from /srv/demo/smoke.txt"
ts=2026-11-16T01:22:51Z level=info step=deploy msg="dry run complete, no changes made"
[exit 0]

# 4. 1.3.0 has a broken migration. The rehearsal on the COPY catches it; live data and service are untouched
$ ship deploy ./dist/demo-1.3.0-aad56a0.tar.gz
ts=2026-11-16T01:22:52Z level=info step=verify msg="checksum ok" sha256="3f6841bfb9f5e3c57827da7da3d17e7ab831ba1024648ef309d7fec182a3e9c2"
ts=2026-11-16T01:22:53Z level=info step=verify msg="manifest ok" name="demo" version="1.3.0" git_sha="aad56a0db80ade2591cb3f22d950df2d87b63bd7" schema_version="3"
ts=2026-11-16T01:22:54Z level=info step=plan msg="deploy plan" release="1.3.0-aad56a0" previous="1.1.0-34fcc21" schema="2->3" migrate="1"
ts=2026-11-16T01:22:54Z level=info step=unpack msg="release unpacked" dir="/srv/demo/releases/1.3.0-aad56a0"
ts=2026-11-16T01:22:55Z level=info step=backup msg="verified backup written" file="/srv/demo/shared/backups/app.sqlite.20261116T012254Z.pre-1.3.0-aad56a0.bak" bytes="20480"
ts=2026-11-16T01:22:55Z level=info step=preflight msg="running migration on a copy of the verified backup"
ts=2026-11-16T01:22:56Z level=error step=preflight msg="migration FAILED on the copy; live data untouched" detail="migrate: applying 003_broken.sql migrate: 003_broken.sql failed: duplicate column name: id "
[exit 6]
$ ship status
current   : 1.1.0-34fcc21
previous  : 1.0.0-d9da58e
releases  : 1.1.0-34fcc21 1.0.0-d9da58e 
service   : active
health    : ok (version 1.1.0)
backup    : app.sqlite.20261116T012254Z.pre-1.3.0-aad56a0.bak verified=yes
history   :
  2026-11-16T01:22:38Z deploy 1.0.0-d9da58e OK
  2026-11-16T01:22:47Z deploy 1.1.0-34fcc21 OK
[exit 0]

# 5. 1.2.0 migrates fine, then crashes on start. Health never turns green, so ship rolls back by itself:

#    it restores the pre-deploy backup and switches 'current' back
$ ship deploy ./dist/demo-1.2.0-b4f6e82.tar.gz
ts=2026-11-16T01:22:59Z level=info step=verify msg="checksum ok" sha256="0b3ea01784b1615cf8419d3f946e7a64b38da0c6ed8e51dd429eddb689bdf07e"
ts=2026-11-16T01:23:01Z level=info step=verify msg="manifest ok" name="demo" version="1.2.0" git_sha="b4f6e8209782fb92ca260cfb20bd45a61d0ba809" schema_version="3"
ts=2026-11-16T01:23:01Z level=info step=plan msg="deploy plan" release="1.2.0-b4f6e82" previous="1.1.0-34fcc21" schema="2->3" migrate="1"
ts=2026-11-16T01:23:02Z level=info step=unpack msg="release unpacked" dir="/srv/demo/releases/1.2.0-b4f6e82"
ts=2026-11-16T01:23:03Z level=info step=backup msg="verified backup written" file="/srv/demo/shared/backups/app.sqlite.20261116T012302Z.pre-1.2.0-b4f6e82.bak" bytes="20480"
ts=2026-11-16T01:23:04Z level=info step=preflight msg="running migration on a copy of the verified backup"
ts=2026-11-16T01:23:04Z level=info step=preflight msg="migration succeeded on the copy"
ts=2026-11-16T01:23:04Z level=info step=migrate msg="stopping demo-app and migrating the live database"
migrate: applying 003_rename_items.sql
migrate: up to date
ts=2026-11-16T01:23:05Z level=info step=switch msg="current now points at the new release" release="1.2.0-b4f6e82"
ts=2026-11-16T01:23:06Z level=info step=health msg="waiting for health" url="http://127.0.0.1:8080/health" version="1.2.0" timeout="8s"
ts=2026-11-16T01:23:09Z level=error step=rollback msg="ROLLING BACK" reason="health check failed: service state is 'failed'"
ts=2026-11-16T01:23:10Z level=info step=restore msg="kept the post-failure database for inspection" file="/srv/demo/shared/data/app.sqlite.failed-20261116T012310Z"
ts=2026-11-16T01:23:10Z level=info step=restore msg="database restored from backup" file="/srv/demo/shared/backups/app.sqlite.20261116T012302Z.pre-1.2.0-b4f6e82.bak"
ts=2026-11-16T01:23:12Z level=info step=rollback msg="previous release is serving again" release="1.1.0-34fcc21" version="1.1.0"
ts=2026-11-16T01:23:12Z level=error step=deploy msg="deploy failed; automatically rolled back" reason="health check failed: service state is 'failed'"
[exit 7]

# State afterwards: 1.1.0 serving, data intact
$ ship status
current   : 1.1.0-34fcc21
previous  : 1.0.0-d9da58e
releases  : 1.2.0-b4f6e82 1.1.0-34fcc21 1.0.0-d9da58e 
service   : active
health    : ok (version 1.1.0)
backup    : app.sqlite.20261116T012302Z.pre-1.2.0-b4f6e82.bak verified=yes
history   :
  2026-11-16T01:22:38Z deploy 1.0.0-d9da58e OK
  2026-11-16T01:22:47Z deploy 1.1.0-34fcc21 OK
  2026-11-16T01:23:12Z deploy 1.2.0-b4f6e82 FAILED rc=7 reason=health check failed: service state is 'failed'
[exit 0]
{"items":[{"id":1,"name":"first item"},{"id":2,"name":"order #1042"}]}

# 6. 1.4.0 starts but /health says 503 (no schema change): rolled back, database left alone
$ ship deploy ./dist/demo-1.4.0-ef52302.tar.gz
ts=2026-11-16T01:23:16Z level=info step=verify msg="checksum ok" sha256="249143b107038b0f594fe64dc66c5441875e7c6936cf986097f6e6f2f8ab8b9a"
ts=2026-11-16T01:23:17Z level=info step=verify msg="manifest ok" name="demo" version="1.4.0" git_sha="ef52302e190fd81435bfce49989f093ff1f9e777" schema_version="2"
ts=2026-11-16T01:23:18Z level=info step=plan msg="deploy plan" release="1.4.0-ef52302" previous="1.1.0-34fcc21" schema="2->2" migrate="0"
ts=2026-11-16T01:23:19Z level=info step=unpack msg="release unpacked" dir="/srv/demo/releases/1.4.0-ef52302"
ts=2026-11-16T01:23:21Z level=info step=backup msg="verified backup written" file="/srv/demo/shared/backups/app.sqlite.20261116T012319Z.pre-1.4.0-ef52302.bak" bytes="20480"
ts=2026-11-16T01:23:21Z level=info step=switch msg="current now points at the new release" release="1.4.0-ef52302"
ts=2026-11-16T01:23:23Z level=info step=health msg="waiting for health" url="http://127.0.0.1:8080/health" version="1.4.0" timeout="8s"
ts=2026-11-16T01:23:31Z level=error step=rollback msg="ROLLING BACK" reason="health check failed: no healthy response yet"
ts=2026-11-16T01:23:33Z level=info step=rollback msg="previous release is serving again" release="1.1.0-34fcc21" version="1.1.0"
ts=2026-11-16T01:23:34Z level=error step=deploy msg="deploy failed; automatically rolled back" reason="health check failed: no healthy response yet"
[exit 7]

# 7. Manual rollback to the previous release, then forward again
$ ship rollback
ts=2026-11-16T01:23:35Z level=info step=rollback msg="plan" from="1.1.0-34fcc21" to="1.0.0-d9da58e" restore_db="no"
ts=2026-11-16T01:23:40Z level=info step=rollback msg="ROLLBACK OK" now="1.0.0-d9da58e" version="1.0.0"
[exit 0]
$ ship rollback
ts=2026-11-16T01:23:41Z level=info step=rollback msg="plan" from="1.0.0-d9da58e" to="1.1.0-34fcc21" restore_db="no"
ts=2026-11-16T01:23:44Z level=info step=rollback msg="ROLLBACK OK" now="1.1.0-34fcc21" version="1.1.0"
[exit 0]
```
