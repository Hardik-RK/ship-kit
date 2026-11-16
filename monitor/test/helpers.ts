import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { Clock } from '../src/types.ts';

export class FakeClock implements Clock {
  t: number;
  constructor(t = Date.UTC(2026, 0, 1, 12, 0, 0)) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  minutes(m: number): void {
    this.advance(m * 60_000);
  }
}

export function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ship-kit-mon-'));
}

export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Self-signed certificate valid for `days` days from now (needs the openssl CLI). */
export function selfSigned(days: number): { key: string; cert: string } {
  const dir = tmpdir();
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', String(days), '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    { stdio: 'ignore' },
  );
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
}

export interface Listening {
  port: number;
  close(): Promise<void>;
}

function wrap(server: http.Server | https.Server | net.Server, port: number): Listening {
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        (server as http.Server).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export async function httpServer(handler: http.RequestListener): Promise<Listening> {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return wrap(s, (s.address() as net.AddressInfo).port);
}

export async function httpsServer(creds: { key: string; cert: string }): Promise<Listening> {
  const s = https.createServer(creds, (_q, res) => res.end('ok'));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return wrap(s, (s.address() as net.AddressInfo).port);
}

export interface FakeSmtp extends Listening {
  messages: Array<{ from: string; to: string[]; data: string; auth?: string; tlsUsed: boolean }>;
}

/** A just-good-enough SMTP server that records what it receives. */
export async function fakeSmtp(opts: { creds?: { key: string; cert: string }; advertiseStarttls?: boolean; rejectRcpt?: boolean } = {}): Promise<FakeSmtp> {
  const messages: FakeSmtp['messages'] = [];
  const server = net.createServer((raw) => {
    let sock: net.Socket = raw;
    let buf = '';
    let inData = false;
    let tlsUsed = false;
    let auth: string | undefined;
    const cur = { from: '', to: [] as string[], data: '' };
    const w = (s: string) => sock.write(s + '\r\n');
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ from: cur.from, to: [...cur.to], data: cur.data, auth, tlsUsed });
            cur.data = '';
            w('250 queued');
          } else cur.data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) {
          const lines = ['250-fake'];
          if (opts.creds && opts.advertiseStarttls !== false && !tlsUsed) lines.push('250-STARTTLS');
          lines.push('250 AUTH PLAIN');
          sock.write(lines.join('\r\n') + '\r\n');
        } else if (up === 'STARTTLS') {
          w('220 ready');
          sock.removeAllListeners('data');
          const ctx = tls.createSecureContext(opts.creds!);
          const ts = new tls.TLSSocket(sock, { isServer: true, secureContext: ctx });
          ts.on('data', onData);
          ts.on('error', () => undefined);
          sock = ts;
          tlsUsed = true;
          buf = '';
        } else if (up.startsWith('AUTH PLAIN')) {
          auth = Buffer.from(line.slice(11), 'base64').toString('utf8').replace(/\0/g, '|');
          w('235 ok');
        } else if (up.startsWith('MAIL FROM:')) {
          cur.from = line.slice(10).replace(/[<>]/g, '');
          cur.to = [];
          w('250 ok');
        } else if (up.startsWith('RCPT TO:')) {
          if (opts.rejectRcpt) w('550 no such user');
          else {
            cur.to.push(line.slice(8).replace(/[<>]/g, ''));
            w('250 ok');
          }
        } else if (up === 'DATA') {
          inData = true;
          w('354 go');
        } else if (up === 'QUIT') {
          w('221 bye');
          sock.end();
        } else w('502 unsupported');
      }
    };
    raw.on('data', onData);
    raw.on('error', () => undefined);
    w('220 fake smtp');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { ...wrap(server, (server.address() as net.AddressInfo).port), messages };
}
