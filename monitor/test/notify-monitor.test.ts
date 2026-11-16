import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { validateConfig, type MonitorConfig } from '../src/config.ts';
import { runOnce, serveStatus } from '../src/monitor.ts';
import { buildNotifiers, formatAlert, type Notifier } from '../src/notify.ts';
import type { Alert } from '../src/types.ts';
import { FakeClock, fakeSmtp, hasOpenssl, httpServer, selfSigned, tmpdir, type Listening } from './helpers.ts';

const servers: Listening[] = [];
after(async () => {
  for (const s of servers) await s.close();
});
const keep = <T extends Listening>(s: T): T => (servers.push(s), s);

const alert: Alert = { kind: 'alert', check: 'health', status: 'crit', message: 'health: HTTP 503, expected 200', since: Date.UTC(2026, 0, 1), retry: { lastNotifiedStatus: null, lastNotifiedAt: 0 } };

function cfg(raw: Record<string, unknown>): MonitorConfig {
  return validateConfig({ name: 'demo', checks: [{ name: 'h', type: 'http', url: 'http://127.0.0.1:1/' }], ...raw });
}

test('format: each kind reads differently', () => {
  assert.equal(formatAlert(alert, 'demo'), '[CRIT] demo: health: HTTP 503, expected 200');
  assert.match(formatAlert({ ...alert, kind: 'recovery', status: 'ok' }, 'demo'), /^\[RECOVERED\]/);
  assert.match(formatAlert({ ...alert, kind: 'reminder' }, 'demo'), /^\[STILL CRIT\]/);
  assert.match(formatAlert({ ...alert, kind: 'flapping' }, 'demo'), /^\[FLAPPING\]/);
});

// ---- webhook / telegram ------------------------------------------------------------------------
test('webhook: posts JSON with text and structured fields, and sends custom headers', async () => {
  const got: Array<{ body: any; auth?: string; url?: string }> = [];
  const s = keep(await httpServer((q, r) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', () => { got.push({ body: JSON.parse(b), auth: q.headers.authorization, url: q.url }); r.end('ok'); });
  }));
  const [n] = buildNotifiers(cfg({ notifiers: [{ type: 'webhook', url: `http://127.0.0.1:${s.port}/hook`, headers: { authorization: 'Bearer t' } }] }).notifiers);
  await n.send(alert, formatAlert(alert, 'demo'), { app: 'demo', now: Date.UTC(2026, 0, 1, 0, 5) });
  assert.equal(got.length, 1);
  assert.equal(got[0].auth, 'Bearer t');
  assert.equal(got[0].url, '/hook');
  assert.equal(got[0].body.text, '[CRIT] demo: health: HTTP 503, expected 200');
  assert.equal(got[0].body.status, 'crit');
  assert.equal(got[0].body.check, 'health');
  assert.equal(got[0].body.since, '2026-01-01T00:00:00.000Z');
});

test('webhook: a non-2xx answer is a delivery failure', async () => {
  const s = keep(await httpServer((_q, r) => { r.statusCode = 500; r.end('nope'); }));
  const [n] = buildNotifiers(cfg({ notifiers: [{ type: 'webhook', url: `http://127.0.0.1:${s.port}/` }] }).notifiers);
  await assert.rejects(n.send(alert, 'x', { app: 'demo', now: 0 }), /HTTP 500/);
});

test('telegram: calls sendMessage with the token from the environment, never from the config file', async () => {
  const got: Array<{ url?: string; body: any }> = [];
  const s = keep(await httpServer((q, r) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', () => { got.push({ url: q.url, body: JSON.parse(b) }); r.end('{"ok":true}'); });
  }));
  const c = cfg({ notifiers: [{ type: 'telegram', tokenEnv: 'TG_TEST_TOKEN', chatId: '42', apiBase: `http://127.0.0.1:${s.port}` }] });
  const [n] = buildNotifiers(c.notifiers, { TG_TEST_TOKEN: '123:abc' });
  await n.send(alert, 'hello', { app: 'demo', now: 0 });
  assert.equal(got[0].url, '/bot123:abc/sendMessage');
  assert.deepEqual(got[0].body, { chat_id: '42', text: 'hello' });
  const [missing] = buildNotifiers(c.notifiers, {});
  await assert.rejects(missing.send(alert, 'x', { app: 'demo', now: 0 }), /TG_TEST_TOKEN is not set/);
});

// ---- smtp --------------------------------------------------------------------------------------
test('email: plain SMTP delivers From/To/Subject/body and dot-stuffs lines', async () => {
  const smtp = keep(await fakeSmtp());
  const c = cfg({ notifiers: [{ type: 'email', host: '127.0.0.1', port: smtp.port, starttls: false, from: 'mon@example.invalid', to: ['a@example.invalid', 'b@example.invalid'] }] });
  const [n] = buildNotifiers(c.notifiers);
  await n.send(alert, '[CRIT] demo: line one\n.line starting with a dot', { app: 'demo', now: Date.UTC(2026, 0, 1) });
  assert.equal(smtp.messages.length, 1);
  const m = smtp.messages[0];
  assert.equal(m.from, 'mon@example.invalid');
  assert.deepEqual(m.to, ['a@example.invalid', 'b@example.invalid']);
  assert.match(m.data, /Subject: \[CRIT\] demo: line one/);
  assert.match(m.data, /\r\n\.line starting with a dot/, 'dot-unstuffed back to the original by the server');
  assert.equal(m.tlsUsed, false);
});

test('email: a rejected recipient is a delivery failure', async () => {
  const smtp = keep(await fakeSmtp({ rejectRcpt: true }));
  const c = cfg({ notifiers: [{ type: 'email', host: '127.0.0.1', port: smtp.port, starttls: false, from: 'm@e.invalid', to: ['a@e.invalid'] }] });
  await assert.rejects(buildNotifiers(c.notifiers)[0].send(alert, 'x', { app: 'demo', now: 0 }), /550/);
});

test('email: refuses to send credentials when STARTTLS is required but not offered', async () => {
  const smtp = keep(await fakeSmtp());
  const c = cfg({ notifiers: [{ type: 'email', host: '127.0.0.1', port: smtp.port, starttls: true, user: 'u', passEnv: 'P', from: 'm@e.invalid', to: ['a@e.invalid'] }] });
  await assert.rejects(buildNotifiers(c.notifiers, { P: 'secret' })[0].send(alert, 'x', { app: 'demo', now: 0 }), /refusing to send credentials in clear text/);
  assert.equal(smtp.messages.length, 0);
});

const tlsTest = hasOpenssl() ? test : test.skip;
tlsTest('email: STARTTLS upgrade then AUTH PLAIN (against a local server with a self-signed cert)', async () => {
  const smtp = keep(await fakeSmtp({ creds: selfSigned(2) }));
  const c = cfg({ notifiers: [{ type: 'email', host: '127.0.0.1', port: smtp.port, starttls: true, insecureTls: true, user: 'u', passEnv: 'P', from: 'm@e.invalid', to: ['a@e.invalid'] }] });
  await buildNotifiers(c.notifiers, { P: 'pw' })[0].send(alert, '[CRIT] over tls', { app: 'demo', now: 0 });
  assert.equal(smtp.messages.length, 1);
  assert.equal(smtp.messages[0].tlsUsed, true);
  assert.equal(smtp.messages[0].auth, '|u|pw');
});
tlsTest('email: an untrusted certificate is rejected unless insecureTls is set', async () => {
  const smtp = keep(await fakeSmtp({ creds: selfSigned(2) }));
  const c = cfg({ notifiers: [{ type: 'email', host: '127.0.0.1', port: smtp.port, starttls: true, from: 'm@e.invalid', to: ['a@e.invalid'] }] });
  await assert.rejects(buildNotifiers(c.notifiers)[0].send(alert, 'x', { app: 'demo', now: 0 }));
  assert.equal(smtp.messages.length, 0);
});

// ---- the whole round ---------------------------------------------------------------------------
class Recorder implements Notifier {
  label = 'recorder';
  sent: string[] = [];
  failing = false;
  async send(_a: Alert, text: string): Promise<void> {
    if (this.failing) throw new Error('down');
    this.sent.push(text);
  }
}

async function liveServer() {
  let status = 200;
  const s = keep(await httpServer((_q, r) => { r.statusCode = status; r.end('{}'); }));
  return { port: s.port, set: (n: number) => (status = n) };
}

test('runOnce: state persists between runs (the cron case): alert on 2nd bad run, once, then recovery', async () => {
  const srv = await liveServer();
  const dir = tmpdir();
  const config = cfg({ stateFile: path.join(dir, 'state.json'), statusFile: path.join(dir, 'status.json'), checks: [{ name: 'web', type: 'http', url: `http://127.0.0.1:${srv.port}/` }] });
  const rec = new Recorder();
  const clock = new FakeClock();
  const run = async () => { const r = await runOnce(config, { notifiers: [rec], clock, out: () => undefined }); clock.minutes(1); return r; };

  await run();
  assert.equal(rec.sent.length, 0);
  srv.set(500);
  await run(); // first bad reading: damped
  assert.equal(rec.sent.length, 0);
  const bad = await run(); // second consecutive: alert
  assert.equal(bad.overall, 'crit');
  assert.deepEqual(rec.sent, ['[CRIT] demo: web: HTTP 500, expected 200 (' + /\((\d+) ms\)/.exec(bad.results[0].message)![1] + ' ms)']);
  await run();
  await run();
  assert.equal(rec.sent.length, 1, 'de-duplicated');
  srv.set(200);
  await run();
  assert.equal(rec.sent.length, 1);
  await run();
  assert.equal(rec.sent.length, 2);
  assert.match(rec.sent[1], /^\[RECOVERED\]/);

  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.app, 'demo');
  assert.equal(status.overall, 'ok');
  assert.equal(status.checks[0].name, 'web');
  assert.equal(status.checks[0].confirmed, 'ok');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left');
});

test('runOnce: if every notifier fails, the alert is retried on the next run', async () => {
  const srv = await liveServer();
  srv.set(500);
  const dir = tmpdir();
  const config = cfg({ stateFile: path.join(dir, 's.json'), alerting: { failAfter: 1, repeatMinutes: 0 }, checks: [{ name: 'web', type: 'http', url: `http://127.0.0.1:${srv.port}/` }] });
  const rec = new Recorder();
  rec.failing = true;
  const clock = new FakeClock();
  const r1 = await runOnce(config, { notifiers: [rec], clock, out: () => undefined });
  assert.equal(r1.deliveryErrors.length, 1);
  assert.equal(rec.sent.length, 0);
  rec.failing = false;
  clock.minutes(1);
  await runOnce(config, { notifiers: [rec], clock, out: () => undefined });
  assert.equal(rec.sent.length, 1);
});

test('runOnce: one working notifier is enough; the failing one is reported', async () => {
  const srv = await liveServer();
  srv.set(500);
  const config = cfg({ alerting: { failAfter: 1 }, checks: [{ name: 'web', type: 'http', url: `http://127.0.0.1:${srv.port}/` }] });
  const good = new Recorder();
  const bad = new Recorder();
  bad.failing = true;
  const r = await runOnce(config, { notifiers: [bad, good], clock: new FakeClock(), out: () => undefined });
  assert.equal(good.sent.length, 1);
  assert.equal(r.deliveryErrors.length, 1);
});

test('dry-run: prints what would be sent, sends nothing, writes no state or status files', async () => {
  const srv = await liveServer();
  srv.set(500);
  const hook = keep(await httpServer(() => { throw new Error('dry run must not call the webhook'); }));
  const dir = tmpdir();
  const config = cfg({
    stateFile: path.join(dir, 'state.json'),
    statusFile: path.join(dir, 'status.json'),
    notifiers: [{ type: 'webhook', url: `http://127.0.0.1:${hook.port}/h` }],
    checks: [{ name: 'web', type: 'http', url: `http://127.0.0.1:${srv.port}/` }],
  });
  const lines: string[] = [];
  const rep = await runOnce(config, { dryRun: true, out: (l) => lines.push(l) });
  assert.equal(rep.alerts.length, 1, 'shown even though the real failAfter is 2');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[dry-run\] would send via webhook http:\/\/127\.0\.0\.1:\d+\/h: \[CRIT\] demo: web: HTTP 500/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('self-test: a synthetic failure shows the alert format even when everything is healthy', async () => {
  const srv = await liveServer();
  const config = cfg({ checks: [{ name: 'web', type: 'http', url: `http://127.0.0.1:${srv.port}/` }] });
  const lines: string[] = [];
  const rep = await runOnce(config, { dryRun: true, synthetic: true, out: (l) => lines.push(l) });
  assert.equal(rep.results.at(-1)!.name, 'self-test');
  assert.equal(rep.alerts.length, 1);
  assert.match(lines.join('\n'), /no notifiers configured\): alert self-test/);
});

test('status server: serves the latest document as JSON, 503 before the first run, 404 elsewhere', async () => {
  let doc: any = null;
  const srv = await serveStatus('127.0.0.1', 0, () => doc);
  const port = (srv.address() as any).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/status.json`)).status, 503);
    doc = { app: 'demo', overall: 'ok', checks: [] };
    const r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), doc);
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })).status, 404);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});
