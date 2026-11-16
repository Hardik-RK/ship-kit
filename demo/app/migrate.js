// Minimal forward-only migration runner: applies migrations/NNN_*.sql in order, once each.
// Usage: DB_PATH=/path/to.sqlite node migrate.js   (ship passes SHIP_DB_PATH)
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.SHIP_DB_PATH || process.env.DB_PATH;
if (!dbPath) { console.error('migrate: set SHIP_DB_PATH or DB_PATH'); process.exit(2); }
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const dir = path.join(__dirname, 'migrations');
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
for (const f of files) {
  const id = parseInt(f, 10);
  if (done.has(id)) continue;
  console.log(`migrate: applying ${f}`);
  db.exec('BEGIN');
  try {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations(id, name) VALUES (?, ?)').run(id, f);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`migrate: ${f} failed: ${e.message}`);
    process.exit(1);
  }
}
console.log('migrate: up to date');
