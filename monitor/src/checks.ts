import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { CheckResult, Clock, Status } from './types.ts';

/** Everything with side effects is injectable so tests can run without a real machine. */
export interface Deps {
  clock: Clock;
  statfs: (p: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number; files: number; ffree: number }>;
  exec: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
}

export const realDeps = (clock: Clock): Deps => ({
  clock,
  statfs: (p) => fs.promises.statfs(p) as any,
  exec: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 127) : 0;
        resolve({ code, stdout: String(stdout ?? '') });
      });
    }),
});

const worst = (...s: Status[]): Status => (s.includes('crit') ? 'crit' : s.includes('warn') ? 'warn' : 'ok');
/** Higher-is-worse thresholds. Pass undefined to disable a level. */
function byHigh(v: number, warn?: number, crit?: number): Status {
  if (crit !== undefined && v >= crit) return 'crit';
  if (warn !== undefined && v >= warn) return 'warn';
  return 'ok';
}
/** Lower-is-worse thresholds (days left). */
function byLow(v: number, warn?: number, crit?: number): Status {
  if (crit !== undefined && v <= crit) return 'crit';
  if (warn !== undefined && v <= warn) return 'warn';
  return 'ok';
}
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---- HTTP --------------------------------------------------------------------------------------
async function httpCheck(c: Record<string, any>): Promise<CheckResult> {
  const base = { name: c.name, type: 'http' };
  const started = performance.now();
  let res: { status: number; body: string };
  try {
    res = await new Promise((resolve, reject) => {
      const u = new URL(c.url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: c.method, timeout: c.timeoutMs, rejectUnauthorized: !c.insecureTls }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (d) => {
          if (body.length < 1_000_000) body += d;
        });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on('timeout', () => req.destroy(new Error(`timed out after ${c.timeoutMs}ms`)));
      req.on('error', reject);
      req.end();
    });
  } catch (e) {
    return { ...base, status: 'crit', message: `request failed: ${(e as Error).message}` };
  }
  const ms = Math.round(performance.now() - started);
  if (res.status !== c.expectStatus) {
    return { ...base, status: 'crit', message: `HTTP ${res.status}, expected ${c.expectStatus} (${ms} ms)`, value: ms, unit: 'ms' };
  }
  let status: Status = byHigh(ms, c.warnLatencyMs, c.critLatencyMs);
  let message = `HTTP ${res.status} in ${ms} ms`;
  if (status !== 'ok') message += ` (slow: ${status === 'crit' ? 'crit' : 'warn'} at ${status === 'crit' ? c.critLatencyMs : c.warnLatencyMs} ms)`;
  if (c.json) {
    let parsed: any;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return { ...base, status: 'crit', message: `${message}; body is not JSON`, value: ms, unit: 'ms' };
    }
    const got = c.json.field.split('.').reduce((o: any, k: string) => (o == null ? undefined : o[k]), parsed);
    if (c.json.exists !== undefined) {
      if ((got !== undefined) !== c.json.exists) {
        status = 'crit';
        message += `; field "${c.json.field}" ${c.json.exists ? 'missing' : 'present'}`;
      }
    }
    if (c.json.equals !== undefined && String(got) !== c.json.equals) {
      status = 'crit';
      message += `; field "${c.json.field}" is ${JSON.stringify(got)}, expected ${JSON.stringify(c.json.equals)}`;
    }
  }
  return { ...base, status, message, value: ms, unit: 'ms' };
}

// ---- TLS certificate expiry --------------------------------------------------------------------
export function tlsCheck(c: Record<string, any>, d: Deps): Promise<CheckResult> {
  const base = { name: c.name, type: 'tls' };
  return new Promise((resolve) => {
    const done = (r: CheckResult) => resolve(r);
    const sock = tls.connect({ host: c.host, port: c.port, servername: c.servername ?? c.host, rejectUnauthorized: false, timeout: c.timeoutMs }, () => {
      const cert = sock.getPeerCertificate();
      const authorized = sock.authorized;
      const authError = sock.authorizationError;
      sock.end();
      if (!cert || !cert.valid_to) return done({ ...base, status: 'crit', message: 'server presented no certificate' });
      const validTo = Date.parse(cert.valid_to);
      const days = Math.floor((validTo - d.clock.now()) / 86_400_000);
      let status = byLow(days, c.warnDays, c.critDays);
      let message = days < 0 ? `certificate EXPIRED ${-days} day(s) ago` : `certificate expires in ${days} day(s) (${new Date(validTo).toISOString().slice(0, 10)})`;
      if (days < 0) status = 'crit';
      if (c.requireTrusted && !authorized) {
        status = 'crit';
        message += `; not trusted: ${String(authError)}`;
      }
      done({ ...base, status, message, value: days, unit: 'days' });
    });
    sock.on('timeout', () => {
      sock.destroy();
      done({ ...base, status: 'crit', message: `TLS connect timed out after ${c.timeoutMs}ms` });
    });
    sock.on('error', (e) => done({ ...base, status: 'crit', message: `TLS connect failed: ${e.message}` }));
  });
}

// ---- disk space and inodes ---------------------------------------------------------------------
async function diskCheck(c: Record<string, any>, d: Deps): Promise<CheckResult> {
  const base = { name: c.name, type: 'disk' };
  let s;
  try {
    s = await d.statfs(c.path);
  } catch (e) {
    return { ...base, status: 'crit', message: `cannot stat ${c.path}: ${(e as Error).message}` };
  }
  // same arithmetic as df: used / (used + available-to-non-root)
  const used = s.blocks - s.bfree;
  const pct = used + s.bavail > 0 ? (used / (used + s.bavail)) * 100 : 0;
  let status = byHigh(pct, c.warnPercent, c.critPercent);
  let message = `${r1(pct)}% of space used on ${c.path}`;
  let inodePct: number | undefined;
  if (s.files > 0) {
    inodePct = ((s.files - s.ffree) / s.files) * 100;
    const is = byHigh(inodePct, c.inodeWarnPercent, c.inodeCritPercent);
    message += `, ${r1(inodePct)}% of inodes`;
    status = worst(status, is);
  } else {
    message += ' (inode counts not reported by this filesystem)';
  }
  return { ...base, status, message, value: r1(Math.max(pct, inodePct ?? 0)), unit: '%' };
}

// ---- systemd unit ------------------------------------------------------------------------------
async function systemdCheck(c: Record<string, any>, d: Deps): Promise<CheckResult> {
  const base = { name: c.name, type: 'systemd' };
  const r = await d.exec('systemctl', ['is-active', c.unit]);
  const state = r.stdout.trim() || (r.code === 127 ? 'systemctl not found' : 'unknown');
  if (state === 'active') return { ...base, status: 'ok', message: `${c.unit} is active` };
  if (state === 'activating' || state === 'reloading') return { ...base, status: 'warn', message: `${c.unit} is ${state}` };
  return { ...base, status: 'crit', message: `${c.unit} is ${state}` };
}

// ---- backup freshness --------------------------------------------------------------------------
async function backupCheck(c: Record<string, any>, d: Deps): Promise<CheckResult> {
  const base = { name: c.name, type: 'backup' };
  let names: string[];
  try {
    names = await fs.promises.readdir(c.dir);
  } catch (e) {
    return { ...base, status: 'crit', message: `cannot read backup dir ${c.dir}: ${(e as Error).message}` };
  }
  const re = new RegExp(c.pattern);
  let newest: { name: string; mtime: number; size: number } | null = null;
  for (const n of names) {
    if (!re.test(n)) continue;
    if (c.requireMarker && !names.includes(n + c.markerSuffix)) continue;
    const st = await fs.promises.stat(path.join(c.dir, n)).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (!newest || st.mtimeMs > newest.mtime) newest = { name: n, mtime: st.mtimeMs, size: st.size };
  }
  const what = c.requireMarker ? 'verified backup' : 'backup';
  if (!newest) return { ...base, status: 'crit', message: `no ${what} files matching /${c.pattern}/ in ${c.dir}` };
  const ageH = (d.clock.now() - newest.mtime) / 3_600_000;
  if (newest.size === 0) return { ...base, status: 'crit', message: `newest ${what} ${newest.name} is empty`, value: r1(ageH), unit: 'hours' };
  const status = byHigh(ageH, c.warnHours, c.critHours);
  return { ...base, status, message: `newest ${what} is ${r1(ageH)} h old (${newest.name})`, value: r1(ageH), unit: 'hours' };
}

// ---- error rate in a log file window -----------------------------------------------------------
const TS_RE = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/;
function lineTime(line: string): number | null {
  const m = TS_RE.exec(line);
  if (!m) return null;
  let tz = m[4] ?? 'Z';
  if (/^[+-]\d{4}$/.test(tz)) tz = tz.slice(0, 3) + ':' + tz.slice(3);
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ''}${tz}`);
  return Number.isNaN(t) ? null : t;
}

export async function lograteCheck(c: Record<string, any>, d: Deps): Promise<CheckResult> {
  const base = { name: c.name, type: 'lograte' };
  let text: string;
  try {
    const fh = await fs.promises.open(c.file, 'r');
    try {
      const st = await fh.stat();
      const len = Math.min(st.size, c.maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      text = buf.toString('utf8');
      if (st.size > len) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    } finally {
      await fh.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && c.missingIsOk) return { ...base, status: 'ok', message: `${c.file} does not exist (allowed)` };
    return { ...base, status: 'crit', message: `cannot read ${c.file}: ${(e as Error).message}` };
  }
  const cutoff = d.clock.now() - c.windowMinutes * 60_000;
  const re = new RegExp(c.errorPattern, 'i');
  let total = 0;
  let errors = 0;
  let current: number | null = null; // continuation lines (stack traces) inherit the previous timestamp
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const t = lineTime(line);
    if (t !== null) current = t;
    if (current === null || current < cutoff) continue;
    total++;
    if (re.test(line)) errors++;
  }
  const rate = total > 0 ? (errors / total) * 100 : 0;
  const countStatus = byHigh(errors, c.warnCount, c.critCount);
  const rateStatus = total >= c.minLinesForRate ? byHigh(rate, c.warnRatePercent, c.critRatePercent) : 'ok';
  const status = worst(countStatus, rateStatus);
  return {
    ...base,
    status,
    message: `${errors} error line(s) of ${total} in the last ${c.windowMinutes} min (${r1(rate)}%)`,
    value: errors,
    unit: 'errors',
  };
}

export async function runCheck(c: Record<string, any>, d: Deps): Promise<CheckResult> {
  try {
    switch (c.type) {
      case 'http': return await httpCheck(c);
      case 'tls': return await tlsCheck(c, d);
      case 'disk': return await diskCheck(c, d);
      case 'systemd': return await systemdCheck(c, d);
      case 'backup': return await backupCheck(c, d);
      case 'lograte': return await lograteCheck(c, d);
      default: return { name: c.name, type: String(c.type), status: 'crit', message: `unknown check type ${c.type}` };
    }
  } catch (e) {
    // a check that blows up is itself a finding, never a silent pass
    return { name: c.name, type: String(c.type), status: 'crit', message: `check crashed: ${(e as Error).message}` };
  }
}
