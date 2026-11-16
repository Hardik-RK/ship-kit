import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { MonitorConfig } from './config.ts';
import { realDeps, runCheck, type Deps } from './checks.ts';
import { evaluate, overall, revertUndelivered } from './alerts.ts';
import { buildNotifiers, deliver, dryRunNotifier, type Notifier } from './notify.ts';
import { systemClock, type Alert, type CheckResult, type Clock, type EngineState } from './types.ts';

export interface RunOptions {
  dryRun?: boolean;
  /** Replace the notifiers (tests). */
  notifiers?: Notifier[];
  deps?: Deps;
  clock?: Clock;
  out?: (line: string) => void;
  /** Add a synthetic CRIT result, so self-test shows exactly what an alert looks like. */
  synthetic?: boolean;
}

export interface RunReport {
  results: CheckResult[];
  alerts: Alert[];
  overall: 'ok' | 'warn' | 'crit';
  deliveryErrors: string[];
}

function atomicWrite(file: string, data: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function loadState(file?: string): EngineState {
  if (!file) return {};
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? (s as EngineState) : {};
  } catch {
    return {}; // first run, or an unreadable file: start clean rather than refuse to monitor
  }
}

export interface StatusDoc {
  app: string;
  generatedAt: string;
  overall: 'ok' | 'warn' | 'crit';
  checks: Array<{ name: string; type: string; status: string; confirmed: string; message: string; value?: number; unit?: string; since: string }>;
}

export function buildStatus(cfg: MonitorConfig, results: CheckResult[], state: EngineState, now: number): StatusDoc {
  return {
    app: cfg.name,
    generatedAt: new Date(now).toISOString(),
    overall: overall(results),
    checks: results.map((r) => ({
      name: r.name,
      type: r.type,
      status: r.status,
      confirmed: state[r.name]?.confirmed ?? r.status,
      message: r.message,
      ...(r.value !== undefined ? { value: r.value, unit: r.unit } : {}),
      since: new Date(state[r.name]?.since ?? now).toISOString(),
    })),
  };
}

/** One full round: run every check, evaluate alert rules, deliver, persist state and status page. */
export async function runOnce(cfg: MonitorConfig, opts: RunOptions = {}): Promise<RunReport> {
  const clock = opts.clock ?? systemClock;
  const deps = opts.deps ?? realDeps(clock);
  const out = opts.out ?? ((s: string) => console.log(s));
  const dry = !!opts.dryRun;

  const results = await Promise.all(cfg.checks.map((c) => runCheck(c, deps)));
  if (opts.synthetic) results.push({ name: 'self-test', type: 'synthetic', status: 'crit', message: 'synthetic failure injected by self-test (nothing is actually wrong)' });

  // Dry-run behaves as if the state were clean and failAfter=1, so every message that could be
  // sent for the current readings is shown. It never reads or writes the state file.
  const alerting = dry ? { ...cfg.alerting, failAfter: 1, recoverAfter: 1 } : cfg.alerting;
  const prev = dry ? {} : loadState(cfg.stateFile);
  const now = clock.now();
  const { state, alerts } = evaluate(prev, results, now, alerting);

  let notifiers = opts.notifiers ?? buildNotifiers(cfg.notifiers);
  if (dry) notifiers = notifiers.map((n) => dryRunNotifier(n, out));
  const deliveryErrors: string[] = [];
  const undelivered: Alert[] = [];
  for (const a of alerts) {
    if (dry && notifiers.length === 0) out(`  [dry-run] would alert (no notifiers configured): ${a.kind} ${a.check}: ${a.message}`);
    const r = await deliver(notifiers, a, cfg.name, now);
    deliveryErrors.push(...r.errors);
    if (!r.delivered) undelivered.push(a);
  }
  revertUndelivered(state, undelivered);

  if (!dry) {
    if (cfg.stateFile) atomicWrite(cfg.stateFile, JSON.stringify(state, null, 1));
    if (cfg.statusFile) atomicWrite(cfg.statusFile, JSON.stringify(buildStatus(cfg, results, state, now), null, 2));
  }
  return { results, alerts, overall: overall(results), deliveryErrors };
}

/** Optional tiny HTTP server for the status JSON: GET / or /status.json, read-only. */
export function serveStatus(host: string, port: number, get: () => StatusDoc | null): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/' && req.url !== '/status.json')) {
      res.writeHead(404).end();
      return;
    }
    const doc = get();
    res.writeHead(doc ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(doc ?? { error: 'no run completed yet' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
