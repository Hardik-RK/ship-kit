// Tiny demo service: /health, /items (GET, POST), backed by SQLite (node:sqlite, Node >= 22.13).
// Version comes from the MANIFEST.json that ship-build put next to this file.
// A file named BUG next to server.js makes the release misbehave on purpose:
//   BUG=crash      -> the process exits on start (what a bad deploy often looks like)
//   BUG=unhealthy  -> it runs, but /health answers 503
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const here = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'MANIFEST.json'), 'utf8'));
const bugFile = path.join(here, 'BUG');
const bug = fs.existsSync(bugFile) ? fs.readFileSync(bugFile, 'utf8').trim() : '';
const port = Number(process.env.PORT || 8080);
const dbPath = process.env.DB_PATH || path.join(here, 'demo.sqlite');

if (bug === 'crash') {
  console.error(`v${manifest.version}: simulated startup crash (BUG=crash)`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
// The app expects the schema that its own migrations create; fail fast if it is not there.
const hasItems = db.prepare("SELECT 1 FROM sqlite_master WHERE name='items'").get();
if (!hasItems) {
  console.error(`v${manifest.version}: table 'items' is missing; the schema does not match this release`);
  process.exit(1);
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    if (bug === 'unhealthy') return send(res, 503, { status: 'error', version: manifest.version });
    return send(res, 200, { status: 'ok', version: manifest.version, schema: manifest.schema_version });
  }
  if (req.method === 'GET' && req.url === '/items') {
    return send(res, 200, { items: db.prepare('SELECT id, name FROM items ORDER BY id').all() });
  }
  if (req.method === 'POST' && req.url === '/items') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        if (typeof name !== 'string' || !name) throw new Error('name required');
        const r = db.prepare('INSERT INTO items(name) VALUES (?)').run(name);
        send(res, 201, { id: Number(r.lastInsertRowid), name });
      } catch (e) {
        send(res, 400, { error: String(e.message) });
      }
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => console.log(`demo v${manifest.version} listening on 127.0.0.1:${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
