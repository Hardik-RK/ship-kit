import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, parseConfigText, validateConfig } from '../src/config.ts';
import { parseYaml, YamlError } from '../src/yaml.ts';

test('yaml: mappings, nested lists, scalars, comments and inline collections', () => {
  const v = parseYaml(`
# comment
name: my app   # trailing comment
count: 3
ratio: 0.5
on: true
nothing: null
quoted: "a: b # not a comment"
single: 'it''s'
list: [1, two, "three, four"]
map: {a: 1, b: x}
items:
  - name: one
    nested:
      k: v
    flag: false
  - plain
  -
    deep: 1
seq_same_indent:
- a
- b
`) as any;
  assert.equal(v.name, 'my app');
  assert.equal(v.count, 3);
  assert.equal(v.ratio, 0.5);
  assert.equal(v.on, true);
  assert.equal(v.nothing, null);
  assert.equal(v.quoted, 'a: b # not a comment');
  assert.equal(v.single, "it's");
  assert.deepEqual(v.list, [1, 'two', 'three, four']);
  assert.deepEqual(v.map, { a: 1, b: 'x' });
  assert.deepEqual(v.items, [{ name: 'one', nested: { k: 'v' }, flag: false }, 'plain', { deep: 1 }]);
  assert.deepEqual(v.seq_same_indent, ['a', 'b']);
});

test('yaml: urls and windows-style values with colons stay strings', () => {
  const v = parseYaml('url: http://127.0.0.1:8080/health\npath: C:/data/backups\n') as any;
  assert.equal(v.url, 'http://127.0.0.1:8080/health');
  assert.equal(v.path, 'C:/data/backups');
});

test('yaml: rejects what it cannot parse instead of guessing', () => {
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tabs/);
  assert.throws(() => parseYaml('a: &x 1\n'), /anchors/);
  assert.throws(() => parseYaml('a: |\n  text\n'), /block scalars/);
  assert.throws(() => parseYaml('a: "open\n'), YamlError);
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), /indentation/);
});

const minimal = { checks: [{ name: 'web', type: 'http', url: 'http://127.0.0.1/health' }] };

test('config: defaults are filled in', () => {
  const c = validateConfig(minimal);
  assert.equal(c.name, 'app');
  assert.equal(c.alerting.failAfter, 2);
  assert.equal(c.alerting.flap.threshold, 4);
  assert.equal(c.checks[0].expectStatus, 200);
  assert.equal(c.checks[0].method, 'GET');
});

test('config: reports every problem at once, with paths', () => {
  try {
    validateConfig({
      intervalSeconds: 1,
      surprise: true,
      checks: [
        { name: 'a', type: 'http' },
        { name: 'a', type: 'tls', host: 'h', warnDays: 3, critDays: 9 },
        { name: 'b', type: 'disk', path: '/', warnPercent: 95, critPercent: 90 },
        { name: 'c', type: 'lograte', file: '/x' },
        { name: 'd', type: 'backup', dir: '/b', pattern: '(' },
        { name: 'e', type: 'nope' },
      ],
      notifiers: [{ type: 'email', host: 'h', from: 'a@b' }, { type: 'carrier-pigeon' }],
    });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    const m = e.errors.join('\n');
    for (const want of [
      'intervalSeconds: must be >= 5',
      'surprise: unknown key',
      'checks[0].url: required',
      'duplicate check name "a"',
      'critDays (9) must be <= warnDays (3)',
      'warnPercent (95) must be <= critPercent (90)',
      'set at least one of warnCount',
      'checks[4].pattern: not a valid regular expression',
      'checks[5].type: must be one of',
      'notifiers[0].to: required',
      'notifiers[1].type: must be one of',
    ]) {
      assert.ok(m.includes(want), `missing "${want}" in:\n${m}`);
    }
  }
});

test('config: typos in keys are errors, not silently ignored', () => {
  assert.throws(() => validateConfig({ checks: [{ name: 'x', type: 'http', url: 'http://h', warnLatencyMS: 5 }] }), /warnLatencyMS: unknown key/);
});

test('config: wrong types are named', () => {
  assert.throws(() => validateConfig({ checks: [{ name: 'x', type: 'http', url: 'http://h', timeoutMs: '5' }] }), /timeoutMs: expected number, got string/);
  assert.throws(() => validateConfig({ checks: [] }), /checks: must not be empty/);
  assert.throws(() => validateConfig({}), /checks: required/);
});

test('config: JSON and YAML forms of the same config are equal', () => {
  const y = parseConfigText('name: x\nchecks:\n  - {name: w, type: http, url: "http://h/health"}\n');
  const j = parseConfigText('{"name":"x","checks":[{"name":"w","type":"http","url":"http://h/health"}]}');
  assert.deepEqual(y, j);
});

test('config: the shipped example files validate (YAML and JSON agree)', () => {
  const dir = path.join(import.meta.dirname, '..', '..', 'examples');
  const y = parseConfigText(fs.readFileSync(path.join(dir, 'monitor.yaml'), 'utf8'), 'monitor.yaml');
  const j = parseConfigText(fs.readFileSync(path.join(dir, 'monitor.json'), 'utf8'), 'monitor.json');
  assert.deepEqual(y, j);
  assert.ok(y.checks.length >= 6);
});

test('config: the published JSON Schema lists the same check types and keys as the validator', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config.schema.json'), 'utf8'));
  assert.equal(schema.$schema.includes('json-schema.org'), true);
  const names = schema.$defs.check.oneOf.map((o: any) => o.properties.type.const).sort();
  assert.deepEqual(names, ['backup', 'disk', 'http', 'lograte', 'systemd', 'tls']);
});

test('config: committed config.schema.json is exactly what the validator tables generate (run `npm run schema` to refresh)', async () => {
  const { toJsonSchema } = await import('../src/schema.ts');
  const committed = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config.schema.json'), 'utf8'));
  assert.deepEqual(committed, toJsonSchema());
});
