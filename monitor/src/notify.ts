import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Alert } from './types.ts';

export interface Notifier {
  /** human label used in logs and dry-run output */
  label: string;
  send(alert: Alert, text: string, ctx: { app: string; now: number }): Promise<void>;
}

const ICON: Record<string, string> = { ok: 'OK', warn: 'WARN', crit: 'CRIT' };

export function formatAlert(a: Alert, app: string): string {
  const head =
    a.kind === 'recovery' ? 'RECOVERED' : a.kind === 'flapping' ? 'FLAPPING' : a.kind === 'stable' ? 'STABLE' : a.kind === 'reminder' ? `STILL ${ICON[a.status]}` : ICON[a.status];
  return `[${head}] ${app}: ${a.message}`;
}

// ---- tiny JSON POST ----------------------------------------------------------------------------
function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request(u, { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let resp = '';
      res.on('data', (d) => (resp += d));
      res.on('end', () => (res.statusCode && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}: ${resp.slice(0, 200)}`))));
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(data);
  });
}

export function webhookNotifier(c: Record<string, any>): Notifier {
  return {
    label: `webhook ${redactUrl(c.url)}`,
    async send(a, text, ctx) {
      // "text" and "content" cover Slack-style and Discord-style incoming webhooks;
      // the rest is for anything that wants structured fields.
      await postJson(
        c.url,
        { text, content: text, app: ctx.app, kind: a.kind, status: a.status, check: a.check, message: a.message, since: new Date(a.since).toISOString(), at: new Date(ctx.now).toISOString() },
        c.headers ?? {},
        c.timeoutMs,
      );
    },
  };
}

export function telegramNotifier(c: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Notifier {
  return {
    label: `telegram chat ${c.chatId}`,
    async send(_a, text) {
      const token = env[c.tokenEnv];
      if (!token) throw new Error(`environment variable ${c.tokenEnv} is not set`);
      await postJson(`${c.apiBase.replace(/\/$/, '')}/bot${token}/sendMessage`, { chat_id: c.chatId, text }, {}, c.timeoutMs);
    },
  };
}

// ---- minimal SMTP client -----------------------------------------------------------------------
/** Reads SMTP replies (handles multi-line "250-..." replies). */
class SmtpConn {
  sock: net.Socket | tls.TLSSocket;
  private buf = '';
  private waiters: Array<(r: { code: number; lines: string[] }) => void> = [];
  private lines: string[] = [];
  private failure: Error | null = null;
  private rejecters: Array<(e: Error) => void> = [];

  constructor(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    this.attach(sock);
  }
  attach(sock: net.Socket | tls.TLSSocket): void {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const w = this.waiters.shift();
          this.rejecters.shift();
          const lines = this.lines;
          this.lines = [];
          w?.({ code: Number(line.slice(0, 3)), lines });
        }
      }
    });
    const fail = (e: Error) => {
      this.failure = e;
      this.rejecters.splice(0).forEach((r) => r(e));
      this.waiters = [];
    };
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('connection closed')));
  }
  reply(): Promise<{ code: number; lines: string[] }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((res, rej) => {
      this.waiters.push(res);
      this.rejecters.push(rej);
    });
  }
  write(s: string): void {
    this.sock.write(s);
  }
  async cmd(line: string, ok: number[]): Promise<{ code: number; lines: string[] }> {
    this.write(line + '\r\n');
    const r = await this.reply();
    if (!ok.includes(r.code)) throw new Error(`SMTP "${line.split(' ')[0]}" rejected: ${r.lines.join(' / ')}`);
    return r;
  }
}

function connect(c: Record<string, any>): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s: net.Socket = c.secure
      ? tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: !c.insecureTls }, () => resolve(s))
      : net.connect({ host: c.host, port: c.port }, () => resolve(s));
    s.setTimeout(c.timeoutMs, () => s.destroy(new Error(`SMTP timed out after ${c.timeoutMs}ms`)));
    s.once('error', reject);
  });
}

export function emailNotifier(c: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Notifier {
  return {
    label: `email via ${c.host}:${c.port} to ${c.to.join(', ')}`,
    async send(a, text, ctx) {
      const sock = await connect(c);
      const conn = new SmtpConn(sock);
      try {
        const greet = await conn.reply();
        if (greet.code !== 220) throw new Error(`SMTP greeting: ${greet.lines.join(' / ')}`);
        let ehlo = await conn.cmd(`EHLO ${c.heloName}`, [250]);
        let encrypted: boolean = c.secure;
        if (!c.secure && c.starttls && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
          await conn.cmd('STARTTLS', [220]);
          conn.sock.removeAllListeners('data'); // the TLS layer owns the raw socket from here on
          const secured = tls.connect({ socket: conn.sock as net.Socket, servername: c.host, rejectUnauthorized: !c.insecureTls });
          await new Promise<void>((res, rej) => {
            secured.once('secureConnect', () => res());
            secured.once('error', rej);
          });
          conn.attach(secured);
          encrypted = true;
          ehlo = await conn.cmd(`EHLO ${c.heloName}`, [250]);
        }
        if (c.user) {
          if (!encrypted) throw new Error('connection is not encrypted; refusing to send credentials in clear text');
          const pass = env[c.passEnv ?? ''];
          if (!pass) throw new Error(`environment variable ${c.passEnv} is not set`);
          await conn.cmd('AUTH PLAIN ' + Buffer.from(`\0${c.user}\0${pass}`).toString('base64'), [235]);
        }
        await conn.cmd(`MAIL FROM:<${c.from}>`, [250]);
        for (const to of c.to) await conn.cmd(`RCPT TO:<${to}>`, [250, 251]);
        await conn.cmd('DATA', [354]);
        const subject = text.length > 120 ? text.slice(0, 117) + '...' : text;
        const msg = [
          `From: ${c.from}`,
          `To: ${c.to.join(', ')}`,
          `Subject: ${subject.replace(/[\r\n]+/g, ' ')}`,
          `Date: ${new Date(ctx.now).toUTCString()}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          text.replace(/\r?\n/g, '\r\n'),
          '',
          `check: ${a.check}`,
          `status: ${a.status}`,
          `since: ${new Date(a.since).toISOString()}`,
        ]
          .join('\r\n')
          .replace(/\r\n\./g, '\r\n..'); // dot-stuffing
        conn.write(msg + '\r\n.\r\n');
        const done = await conn.reply();
        if (done.code !== 250) throw new Error(`SMTP DATA rejected: ${done.lines.join(' / ')}`);
        await conn.cmd('QUIT', [221]).catch(() => undefined);
      } finally {
        conn.sock.destroy();
      }
    },
  };
}

function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname.length > 12 ? x.pathname.slice(0, 8) + '...' : x.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

export function buildNotifiers(list: Array<Record<string, any>>, env: NodeJS.ProcessEnv = process.env): Notifier[] {
  return list.map((c) => (c.type === 'webhook' ? webhookNotifier(c) : c.type === 'telegram' ? telegramNotifier(c, env) : emailNotifier(c, env)));
}

/** Dry-run: print what would be sent, send nothing. */
export function dryRunNotifier(inner: Notifier, out: (s: string) => void): Notifier {
  return {
    label: inner.label,
    async send(_a, text) {
      out(`  [dry-run] would send via ${inner.label}: ${text}`);
    },
  };
}

/** Deliver to every notifier; resolves with whether at least one accepted it, plus per-notifier errors. */
export async function deliver(notifiers: Notifier[], alert: Alert, app: string, now: number): Promise<{ delivered: boolean; errors: string[] }> {
  const text = formatAlert(alert, app);
  const errors: string[] = [];
  let ok = notifiers.length === 0; // nothing configured: nothing to retry
  await Promise.all(
    notifiers.map(async (n) => {
      try {
        await n.send(alert, text, { app, now });
        ok = true;
      } catch (e) {
        errors.push(`${n.label}: ${(e as Error).message}`);
      }
    }),
  );
  return { delivered: ok, errors };
}
