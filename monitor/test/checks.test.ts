import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { realDeps, runCheck, type Deps } from '../src/checks.ts';
import { validateConfig } from '../src/config.ts';
import { FakeClock, hasOpenssl, httpServer, httpsServer, selfSigned, tmpdir, type Listening } from './helpers.ts';

/** Run one check config through the real validator (so defaults apply), then the check. */
async function check(raw: Record<string, unknown>, deps: Deps) {
  const cfg = validateConfig({ checks: [{ name: 't', ...raw }] });
  return runCheck(cfg.checks[0], deps);
}
const clock = new FakeClock();
const deps = (over: Partial<Deps> = {}): Deps => ({ ...realDeps(clock), ...over });

const servers: Listening[] = [];
after(async () => {
  for (const s of servers) await s.close();
});
const serve = async (h: Parameters<typeof httpServer>[0]) => {
  const s = await httpServer(h);
  servers.push(s);
  return s;
};

// ---- http --------------------------------------------------------------------------------------
test('http: healthy endpoint is ok and reports latency', async () => {
  const s = await serve((_q, r) => r.end('{"status":"ok"}'));
  const r = await check({ type: 'http', url: `http://127.0.0.1:${s.port}/health` }, deps());
  assert.equal(r.status, 'ok');
  assert.match(r.message, /HTTP 200 in \d+ ms/);
  assert.equal(r.unit, 'ms');
});

test('http: unexpected status code is crit', async () => {
  const s = await serve((_q, r) => { r.statusCode = 503; r.end('down'); });
  const r = await check({ type: 'http', url: `http://127.0.0.1:${s.port}/` }, deps());
  assert.equal(r.status, 'crit');
  assert.match(r.message, /HTTP 503, expected 200/);
});

test('http: expectStatus can be something other than 200', async () => {
  const s = await serve((_q, r) => { r.statusCode = 204; r.end(); });
  assert.equal((await check({ type: 'http', url: `http://127.0.0.1:${s.port}/`, expectStatus: 204 }, deps())).status, 'ok');
});

test('http: slow responses are warn, then crit, by latency thresholds', async () => {
  const s = await serve((_q, r) => setTimeout(() => r.end('ok'), 250));
  const url = `http://127.0.0.1:${s.port}/`;
  assert.equal((await check({ type: 'http', url, warnLatencyMs: 100, critLatencyMs: 5000 }, deps())).status, 'warn');
  assert.equal((await check({ type: 'http', url, warnLatencyMs: 50, critLatencyMs: 150 }, deps())).status, 'crit');
  assert.equal((await check({ type: 'http', url, warnLatencyMs: 5000 }, deps())).status, 'ok');
});

test('http: JSON field must match', async () => {
  const s = await serve((q, r) => r.end(q.url === '/bad' ? '{"status":"degraded","db":{"up":true}}' : '{"status":"ok","db":{"up":true}}'));
  const base = `http://127.0.0.1:${s.port}`;
  assert.equal((await check({ type: 'http', url: `${base}/ok`, json: { field: 'status', equals: 'ok' } }, deps())).status, 'ok');
  const bad = await check({ type: 'http', url: `${base}/bad`, json: { field: 'status', equals: 'ok' } }, deps());
  assert.equal(bad.status, 'crit');
  assert.match(bad.message, /"degraded"/);
  assert.equal((await check({ type: 'http', url: `${base}/ok`, json: { field: 'db.up', equals: 'true' } }, deps())).status, 'ok');
  assert.equal((await check({ type: 'http', url: `${base}/ok`, json: { field: 'nope', exists: true } }, deps())).status, 'crit');
});

test('http: a non-JSON body fails a json check', async () => {
  const s = await serve((_q, r) => r.end('<html>'));
  const r = await check({ type: 'http', url: `http://127.0.0.1:${s.port}/`, json: { field: 'status', equals: 'ok' } }, deps());
  assert.equal(r.status, 'crit');
  assert.match(r.message, /not JSON/);
});

test('http: connection refused and timeouts are crit with a reason', async () => {
  const s = await serve(() => undefined); // never answers
  const slow = await check({ type: 'http', url: `http://127.0.0.1:${s.port}/`, timeoutMs: 300 }, deps());
  assert.equal(slow.status, 'crit');
  assert.match(slow.message, /timed out/);
  const dead = await httpServer(() => undefined);
  const port = dead.port;
  await dead.close();
  const refused = await check({ type: 'http', url: `http://127.0.0.1:${port}/` }, deps());
  assert.equal(refused.status, 'crit');
  assert.match(refused.message, /request failed/);
});

// ---- tls ---------------------------------------------------------------------------------------
const tlsTest = hasOpenssl() ? test : test.skip;
tlsTest('tls: expiry days are measured against the (fake) clock: ok, warn, crit, expired', async () => {
  const s = await httpsServer(selfSigned(30));
  servers.push(s);
  const c = new FakeClock(Date.now());
  const run = (days: number) => {
    c.t = Date.now() + days * 86_400_000;
    return check({ type: 'tls', host: '127.0.0.1', port: s.port, servername: 'localhost', warnDays: 21, critDays: 7 }, deps({ clock: c }));
  };
  const ok = await run(0);
  assert.equal(ok.status, 'ok');
  assert.ok(ok.value! >= 29 && ok.value! <= 30, `days=${ok.value}`);
  const warn = await run(15);
  assert.equal(warn.status, 'warn');
  assert.ok(warn.value! >= 14 && warn.value! <= 15);
  assert.equal((await run(25)).status, 'crit');
  const expired = await run(40);
  assert.equal(expired.status, 'crit');
  assert.match(expired.message, /EXPIRED \d+ day/);
});

tlsTest('tls: requireTrusted fails a self-signed certificate; default ignores trust and only checks expiry', async () => {
  const s = await httpsServer(selfSigned(30));
  servers.push(s);
  const base = { type: 'tls', host: '127.0.0.1', port: s.port, servername: 'localhost' };
  assert.equal((await check(base, deps({ clock: new FakeClock(Date.now()) }))).status, 'ok');
  const strict = await check({ ...base, requireTrusted: true }, deps({ clock: new FakeClock(Date.now()) }));
  assert.equal(strict.status, 'crit');
  assert.match(strict.message, /not trusted/);
});

test('tls: a port with no TLS (or nothing listening) is crit', async () => {
  const plain = await serve((_q, r) => r.end('plain'));
  const r = await check({ type: 'tls', host: '127.0.0.1', port: plain.port, timeoutMs: 500 }, deps());
  assert.equal(r.status, 'crit');
  assert.match(r.message, /TLS connect (failed|timed out)/);
});

// ---- disk --------------------------------------------------------------------------------------
const fsStat = (usedPct: number, inodePct = 10) => async () => ({
  bsize: 4096, blocks: 1000, bfree: 1000 - usedPct * 10, bavail: 1000 - usedPct * 10, files: 1000, ffree: 1000 - inodePct * 10,
});
test('disk: space thresholds (df arithmetic)', async () => {
  for (const [pct, want] of [[50, 'ok'], [80, 'warn'], [92, 'crit']] as const) {
    const r = await check({ type: 'disk', path: '/' }, deps({ statfs: fsStat(pct) }));
    assert.equal(r.status, want, `${pct}%`);
  }
});
test('disk: inode exhaustion is caught even with free space', async () => {
  const r = await check({ type: 'disk', path: '/' }, deps({ statfs: fsStat(10, 95) }));
  assert.equal(r.status, 'crit');
  assert.match(r.message, /95% of inodes/);
});
test('disk: filesystems that do not report inodes are not treated as failing', async () => {
  const r = await check({ type: 'disk', path: '/' }, deps({ statfs: async () => ({ bsize: 1, blocks: 100, bfree: 60, bavail: 60, files: 0, ffree: 0 }) }));
  assert.equal(r.status, 'ok');
  assert.match(r.message, /inode counts not reported/);
});
test('disk: a path that cannot be stat-ed is crit', async () => {
  const r = await check({ type: 'disk', path: '/definitely/not/here' }, deps());
  assert.equal(r.status, 'crit');
});
test('disk: works against the real filesystem', async () => {
  const r = await check({ type: 'disk', path: tmpdir(), warnPercent: 100, critPercent: 100, inodeWarnPercent: 100, inodeCritPercent: 100 }, deps());
  assert.equal(r.status, 'ok');
  assert.match(r.message, /% of space used/);
});

// ---- systemd -----------------------------------------------------------------------------------
test('systemd: active / activating / failed / missing systemctl', async () => {
  const exec = (stdout: string, code = 0) => async () => ({ code, stdout });
  assert.equal((await check({ type: 'systemd', unit: 'x' }, deps({ exec: exec('active\n') }))).status, 'ok');
  assert.equal((await check({ type: 'systemd', unit: 'x' }, deps({ exec: exec('activating\n', 3) }))).status, 'warn');
  const failed = await check({ type: 'systemd', unit: 'x' }, deps({ exec: exec('failed\n', 3) }));
  assert.equal(failed.status, 'crit');
  assert.match(failed.message, /x is failed/);
  const missing = await check({ type: 'systemd', unit: 'x' }, deps({ exec: exec('', 127) }));
  assert.equal(missing.status, 'crit');
  assert.match(missing.message, /systemctl not found/);
});

// ---- backup freshness --------------------------------------------------------------------------
function backupDir(files: Array<{ name: string; ageHours: number; size?: number }>, now: number): string {
  const dir = tmpdir();
  for (const f of files) {
    const p = path.join(dir, f.name);
    fs.writeFileSync(p, 'x'.repeat(f.size ?? 10));
    const t = new Date(now - f.ageHours * 3_600_000);
    fs.utimesSync(p, t, t);
  }
  return dir;
}
test('backup: age of the newest matching file against warn/crit hours', async () => {
  const now = Date.now();
  const c = new FakeClock(now);
  const dir = backupDir([{ name: 'a.bak', ageHours: 80 }, { name: 'b.bak', ageHours: 10 }, { name: 'c.txt', ageHours: 1 }], now);
  assert.equal((await check({ type: 'backup', dir }, deps({ clock: c }))).status, 'ok');
  c.t = now + 20 * 3_600_000; // newest is now 30 h old
  assert.equal((await check({ type: 'backup', dir }, deps({ clock: c }))).status, 'warn');
  c.t = now + 50 * 3_600_000; // 60 h old
  const crit = await check({ type: 'backup', dir }, deps({ clock: c }));
  assert.equal(crit.status, 'crit');
  assert.match(crit.message, /b\.bak/);
});
test('backup: only verified backups count when requireMarker is set', async () => {
  const now = Date.now();
  const dir = backupDir([{ name: 'new.bak', ageHours: 1 }, { name: 'old.bak', ageHours: 30 }, { name: 'old.bak.ok', ageHours: 30 }], now);
  const r = await check({ type: 'backup', dir, requireMarker: true }, deps({ clock: new FakeClock(now) }));
  assert.equal(r.status, 'warn');
  assert.match(r.message, /verified backup is 30(\.0)? h old \(old\.bak\)/);
});
test('backup: no files, an empty newest file, and a missing directory are crit', async () => {
  const now = Date.now();
  assert.equal((await check({ type: 'backup', dir: tmpdir() }, deps())).status, 'crit');
  const dir = backupDir([{ name: 'z.bak', ageHours: 1, size: 0 }], now);
  const empty = await check({ type: 'backup', dir }, deps({ clock: new FakeClock(now) }));
  assert.equal(empty.status, 'crit');
  assert.match(empty.message, /empty/);
  assert.equal((await check({ type: 'backup', dir: '/no/such/dir' }, deps())).status, 'crit');
});

// ---- log error rate ----------------------------------------------------------------------------
function logFile(lines: string[]): string {
  const f = path.join(tmpdir(), 'app.log');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}
const at = (c: FakeClock, minAgo: number) => new Date(c.t - minAgo * 60_000).toISOString();

test('lograte: counts only error lines inside the window', async () => {
  const c = new FakeClock();
  const file = logFile([
    `${at(c, 90)} ERROR old and out of the window`,
    `${at(c, 90)} ERROR old and out of the window`,
    `${at(c, 5)} INFO fine`,
    `${at(c, 4)} ERROR boom`,
    `${at(c, 3)} level=error msg=oops`,
    `${at(c, 2)} INFO fine`,
  ]);
  const r = await check({ type: 'lograte', file, windowMinutes: 10, warnCount: 2, critCount: 5 }, deps({ clock: c }));
  assert.equal(r.status, 'warn');
  assert.equal(r.value, 2);
  assert.match(r.message, /2 error line\(s\) of 4 in the last 10 min \(50%\)/);
});
test('lograte: continuation lines (stack traces) belong to the line above them', async () => {
  const c = new FakeClock();
  const file = logFile([`${at(c, 1)} ERROR Unhandled`, '    at foo (a.js:1)', '    at bar (b.js:2)', `${at(c, 1)} INFO ok`]);
  const r = await check({ type: 'lograte', file, warnCount: 1, critCount: 3 }, deps({ clock: c }));
  assert.match(r.message, /1 error line\(s\) of 4/);
});
test('lograte: rate thresholds need enough lines to mean anything', async () => {
  const c = new FakeClock();
  const few = logFile([`${at(c, 1)} ERROR a`, `${at(c, 1)} ERROR b`]);
  assert.equal((await check({ type: 'lograte', file: few, critRatePercent: 50 }, deps({ clock: c }))).status, 'ok');
  const many = logFile([...Array(30).fill(`${at(c, 1)} ERROR a`), ...Array(10).fill(`${at(c, 1)} INFO b`)]);
  assert.equal((await check({ type: 'lograte', file: many, warnRatePercent: 10, critRatePercent: 50 }, deps({ clock: c }))).status, 'crit');
});
test('lograte: JSON log lines and timezone offsets', async () => {
  const c = new FakeClock(Date.UTC(2026, 0, 1, 12, 0, 0));
  const file = logFile([
    '{"time":"2026-01-01T11:58:00.000Z","level":"error","msg":"x"}',
    '{"time":"2026-01-01T13:58:30+02:00","level":"info","msg":"y"}',
    '{"time":"2026-01-01T09:00:00+00:00","level":"error","msg":"too old"}',
  ]);
  const r = await check({ type: 'lograte', file, windowMinutes: 10, critCount: 1 }, deps({ clock: c }));
  assert.equal(r.status, 'crit');
  assert.match(r.message, /1 error line\(s\) of 2/);
});
test('lograte: reads only the tail of big files', async () => {
  const c = new FakeClock();
  const file = logFile([`${at(c, 1)} ERROR ancient-but-timestamped-recent`, ...Array(2000).fill(`${at(c, 1)} INFO filler line to push the first line out`)]);
  const r = await check({ type: 'lograte', file, maxBytes: 4096, critCount: 1 }, deps({ clock: c }));
  assert.equal(r.status, 'ok', 'the old ERROR line is outside the tail we read');
});
test('lograte: missing file is crit unless allowed', async () => {
  const f = path.join(tmpdir(), 'nope.log');
  assert.equal((await check({ type: 'lograte', file: f, critCount: 1 }, deps())).status, 'crit');
  assert.equal((await check({ type: 'lograte', file: f, critCount: 1, missingIsOk: true }, deps())).status, 'ok');
});

test('a check that throws becomes a crit result, never a silent pass', async () => {
  const r = await check({ type: 'systemd', unit: 'x' }, deps({ exec: async () => { throw new Error('boom'); } }));
  assert.equal(r.status, 'crit');
  assert.match(r.message, /check crashed: boom/);
});
