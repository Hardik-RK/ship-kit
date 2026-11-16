import { readFileSync } from 'node:fs';
import { parseYaml } from './yaml.ts';

// ---- a tiny schema engine (no dependencies) ----------------------------------------------------

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';
export interface Field {
  type: FieldType;
  required?: boolean;
  default?: unknown;
  enum?: readonly string[];
  min?: number;
  max?: number;
  integer?: boolean;
  regex?: boolean; // string must compile as a RegExp
  items?: Field; // for arrays
  props?: Schema; // for objects
  nonEmpty?: boolean; // arrays
}
export type Schema = Record<string, Field>;

const str = (extra: Partial<Field> = {}): Field => ({ type: 'string', ...extra });
const num = (extra: Partial<Field> = {}): Field => ({ type: 'number', ...extra });
const bool = (extra: Partial<Field> = {}): Field => ({ type: 'boolean', ...extra });

function typeOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

function validateField(v: unknown, f: Field, path: string, errs: string[]): unknown {
  if (typeOf(v) !== f.type) {
    errs.push(`${path}: expected ${f.type}, got ${typeOf(v)}`);
    return undefined;
  }
  if (f.type === 'number') {
    const n = v as number;
    if (!Number.isFinite(n)) errs.push(`${path}: must be a finite number`);
    if (f.integer && !Number.isInteger(n)) errs.push(`${path}: must be an integer`);
    if (f.min !== undefined && n < f.min) errs.push(`${path}: must be >= ${f.min}`);
    if (f.max !== undefined && n > f.max) errs.push(`${path}: must be <= ${f.max}`);
  }
  if (f.type === 'string') {
    const s = v as string;
    if (f.enum && !f.enum.includes(s)) errs.push(`${path}: must be one of ${f.enum.join(', ')} (got "${s}")`);
    if (f.regex) {
      try {
        new RegExp(s);
      } catch (e) {
        errs.push(`${path}: not a valid regular expression (${(e as Error).message})`);
      }
    }
    if (s === '') errs.push(`${path}: must not be empty`);
  }
  if (f.type === 'array') {
    const a = v as unknown[];
    if (f.nonEmpty && a.length === 0) errs.push(`${path}: must not be empty`);
    if (f.items) return a.map((x, i) => validateField(x, f.items!, `${path}[${i}]`, errs));
  }
  if (f.type === 'object' && f.props) return validateObject(v, f.props, path, errs);
  return v;
}

export function validateObject(v: unknown, schema: Schema, path: string, errs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeOf(v) !== 'object') {
    errs.push(`${path || '(root)'}: expected an object, got ${typeOf(v)}`);
    return out;
  }
  const obj = v as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!(k in schema)) errs.push(`${path ? path + '.' : ''}${k}: unknown key (typo?). Allowed: ${Object.keys(schema).join(', ')}`);
  }
  for (const [k, f] of Object.entries(schema)) {
    const p = `${path ? path + '.' : ''}${k}`;
    if (obj[k] === undefined || obj[k] === null) {
      if (f.required) errs.push(`${p}: required`);
      else if (f.default !== undefined) out[k] = f.type === 'object' && f.props ? validateObject(structuredClone(f.default), f.props, p, errs) : structuredClone(f.default);
      continue;
    }
    out[k] = validateField(obj[k], f, p, errs);
  }
  return out;
}

// ---- the config shape --------------------------------------------------------------------------

export const CHECK_SCHEMAS: Record<string, Schema> = {
  http: {
    name: str({ required: true }),
    type: str({ required: true }),
    url: str({ required: true }),
    method: str({ enum: ['GET', 'HEAD'], default: 'GET' }),
    expectStatus: num({ integer: true, min: 100, max: 599, default: 200 }),
    timeoutMs: num({ integer: true, min: 100, default: 5000 }),
    warnLatencyMs: num({ min: 1 }),
    critLatencyMs: num({ min: 1 }),
    json: {
      type: 'object',
      props: { field: str({ required: true }), equals: str() , exists: bool() },
    },
    insecureTls: bool({ default: false }),
  },
  tls: {
    name: str({ required: true }),
    type: str({ required: true }),
    host: str({ required: true }),
    port: num({ integer: true, min: 1, max: 65535, default: 443 }),
    servername: str(),
    warnDays: num({ min: 0, default: 21 }),
    critDays: num({ min: 0, default: 7 }),
    requireTrusted: bool({ default: false }),
    timeoutMs: num({ integer: true, min: 100, default: 5000 }),
  },
  disk: {
    name: str({ required: true }),
    type: str({ required: true }),
    path: str({ required: true }),
    warnPercent: num({ min: 1, max: 100, default: 80 }),
    critPercent: num({ min: 1, max: 100, default: 90 }),
    inodeWarnPercent: num({ min: 1, max: 100, default: 80 }),
    inodeCritPercent: num({ min: 1, max: 100, default: 90 }),
  },
  systemd: {
    name: str({ required: true }),
    type: str({ required: true }),
    unit: str({ required: true }),
  },
  backup: {
    name: str({ required: true }),
    type: str({ required: true }),
    dir: str({ required: true }),
    pattern: str({ regex: true, default: '\\.bak$' }),
    requireMarker: bool({ default: false }),
    markerSuffix: str({ default: '.ok' }),
    warnHours: num({ min: 0, default: 26 }),
    critHours: num({ min: 0, default: 50 }),
  },
  lograte: {
    name: str({ required: true }),
    type: str({ required: true }),
    file: str({ required: true }),
    windowMinutes: num({ min: 1, default: 10 }),
    errorPattern: str({ regex: true, default: '\\b(ERROR|FATAL|CRITICAL)\\b|level=error|"level":\\s*"error"' }),
    warnCount: num({ min: 1 }),
    critCount: num({ min: 1 }),
    warnRatePercent: num({ min: 0, max: 100 }),
    critRatePercent: num({ min: 0, max: 100 }),
    minLinesForRate: num({ min: 1, default: 20 }),
    maxBytes: num({ integer: true, min: 1024, default: 2_000_000 }),
    missingIsOk: bool({ default: false }),
  },
};

export const NOTIFIER_SCHEMAS: Record<string, Schema> = {
  webhook: {
    type: str({ required: true }),
    url: str({ required: true }),
    headers: { type: 'object' },
    timeoutMs: num({ integer: true, min: 100, default: 8000 }),
  },
  telegram: {
    type: str({ required: true }),
    tokenEnv: str({ required: true }),
    chatId: str({ required: true }),
    apiBase: str({ default: 'https://api.telegram.org' }),
    timeoutMs: num({ integer: true, min: 100, default: 8000 }),
  },
  email: {
    type: str({ required: true }),
    host: str({ required: true }),
    port: num({ integer: true, min: 1, max: 65535, default: 587 }),
    secure: bool({ default: false }),
    starttls: bool({ default: true }),
    insecureTls: bool({ default: false }),
    user: str(),
    passEnv: str(),
    from: str({ required: true }),
    to: { type: 'array', required: true, nonEmpty: true, items: str() },
    heloName: str({ default: 'ship-kit-monitor' }),
    timeoutMs: num({ integer: true, min: 100, default: 10000 }),
  },
};

export const TOP_SCHEMA: Schema = {
  name: str({ default: 'app' }),
  intervalSeconds: num({ min: 5, default: 60 }),
  stateFile: str(),
  statusFile: str(),
  serve: {
    type: 'object',
    props: { port: num({ integer: true, min: 1, max: 65535, required: true }), host: str({ default: '127.0.0.1' }) },
  },
  alerting: {
    type: 'object',
    default: {},
    props: {
      failAfter: num({ integer: true, min: 1, default: 2 }),
      recoverAfter: num({ integer: true, min: 1, default: 2 }),
      repeatMinutes: num({ min: 0, default: 120 }),
      flap: {
        type: 'object',
        default: {},
        props: {
          threshold: num({ integer: true, min: 2, default: 4 }),
          windowMinutes: num({ min: 1, default: 30 }),
        },
      },
    },
  },
  notifiers: { type: 'array', default: [], items: { type: 'object' } },
  checks: { type: 'array', required: true, nonEmpty: true, items: { type: 'object' } },
};

// ---- public types ------------------------------------------------------------------------------

export interface MonitorConfig {
  name: string;
  intervalSeconds: number;
  stateFile?: string;
  statusFile?: string;
  serve?: { port: number; host: string };
  alerting: { failAfter: number; recoverAfter: number; repeatMinutes: number; flap: { threshold: number; windowMinutes: number } };
  notifiers: Array<Record<string, any>>;
  checks: Array<Record<string, any>>;
}

export class ConfigError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`invalid configuration:\n  - ${errors.join('\n  - ')}`);
    this.errors = errors;
  }
}

/** Validate an already-parsed object. Throws ConfigError listing every problem at once. */
export function validateConfig(raw: unknown): MonitorConfig {
  const errs: string[] = [];
  const top = validateObject(raw, TOP_SCHEMA, '', errs) as Record<string, any>;
  const checks: Array<Record<string, any>> = [];
  const names = new Set<string>();
  (Array.isArray((raw as any)?.checks) ? (raw as any).checks : []).forEach((c: unknown, i: number) => {
    const p = `checks[${i}]`;
    const t = typeOf(c) === 'object' ? (c as any).type : undefined;
    if (typeof t !== 'string' || !(t in CHECK_SCHEMAS)) {
      errs.push(`${p}.type: must be one of ${Object.keys(CHECK_SCHEMAS).join(', ')}`);
      return;
    }
    const v = validateObject(c, CHECK_SCHEMAS[t], p, errs);
    if (typeof v.name === 'string') {
      if (names.has(v.name)) errs.push(`${p}.name: duplicate check name "${v.name}"`);
      names.add(v.name);
    }
    crossCheck(v, p, errs);
    checks.push(v);
  });
  const notifiers: Array<Record<string, any>> = [];
  (Array.isArray((raw as any)?.notifiers) ? (raw as any).notifiers : []).forEach((n: unknown, i: number) => {
    const p = `notifiers[${i}]`;
    const t = typeOf(n) === 'object' ? (n as any).type : undefined;
    if (typeof t !== 'string' || !(t in NOTIFIER_SCHEMAS)) {
      errs.push(`${p}.type: must be one of ${Object.keys(NOTIFIER_SCHEMAS).join(', ')}`);
      return;
    }
    notifiers.push(validateObject(n, NOTIFIER_SCHEMAS[t], p, errs));
  });
  if (errs.length) throw new ConfigError(errs);
  return { ...top, checks, notifiers } as unknown as MonitorConfig;
}

function crossCheck(v: Record<string, any>, p: string, errs: string[]): void {
  const lt = (a: string, b: string, why: string) => {
    if (typeof v[a] === 'number' && typeof v[b] === 'number' && v[a] > v[b]) errs.push(`${p}: ${a} (${v[a]}) must be <= ${b} (${v[b]}) ${why}`);
  };
  if (v.type === 'tls') lt('critDays', 'warnDays', '(crit fires at fewer days left than warn)');
  if (v.type === 'disk') {
    lt('warnPercent', 'critPercent', '');
    lt('inodeWarnPercent', 'inodeCritPercent', '');
  }
  if (v.type === 'http') lt('warnLatencyMs', 'critLatencyMs', '');
  if (v.type === 'backup') lt('warnHours', 'critHours', '');
  if (v.type === 'lograte') {
    lt('warnCount', 'critCount', '');
    lt('warnRatePercent', 'critRatePercent', '');
    if (v.warnCount === undefined && v.critCount === undefined && v.warnRatePercent === undefined && v.critRatePercent === undefined) {
      errs.push(`${p}: set at least one of warnCount, critCount, warnRatePercent, critRatePercent`);
    }
  }
  if (v.type === 'http' && v.json && v.json.equals === undefined && v.json.exists === undefined) {
    errs.push(`${p}.json: set "equals" or "exists"`);
  }
}

/** Parse YAML or JSON text (JSON is tried first when the text starts with { ) and validate it. */
export function parseConfigText(text: string, hint = ''): MonitorConfig {
  let raw: unknown;
  const looksJson = text.trimStart().startsWith('{') || hint.endsWith('.json');
  try {
    raw = looksJson ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ConfigError([`could not parse ${hint || 'config'}: ${(e as Error).message}`]);
  }
  return validateConfig(raw);
}

export function loadConfig(file: string): MonitorConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError([`cannot read ${file}: ${(e as Error).message}`]);
  }
  return parseConfigText(text, file);
}
