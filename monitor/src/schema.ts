import { CHECK_SCHEMAS, NOTIFIER_SCHEMAS, TOP_SCHEMA, type Field, type Schema } from './config.ts';

function field(f: Field): Record<string, unknown> {
  const o: Record<string, unknown> = { type: f.integer ? 'integer' : f.type };
  if (f.enum) o.enum = [...f.enum];
  if (f.min !== undefined) o.minimum = f.min;
  if (f.max !== undefined) o.maximum = f.max;
  if (f.default !== undefined) o.default = f.default;
  if (f.type === 'string') o.minLength = 1;
  if (f.regex) o.format = 'regex';
  if (f.type === 'array') {
    if (f.items) o.items = field(f.items);
    if (f.nonEmpty) o.minItems = 1;
  }
  if (f.type === 'object' && f.props) Object.assign(o, objectSchema(f.props));
  return o;
}

function objectSchema(s: Schema, constType?: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, f] of Object.entries(s)) {
    properties[k] = k === 'type' && constType ? { const: constType } : field(f);
    if (f.required) required.push(k);
  }
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

/** JSON Schema (draft 2020-12) generated from the same tables the validator uses, so they cannot drift. */
export function toJsonSchema(): Record<string, unknown> {
  const top = objectSchema(TOP_SCHEMA) as any;
  top.properties.checks = { type: 'array', minItems: 1, items: { $ref: '#/$defs/check' } };
  top.properties.notifiers = { type: 'array', default: [], items: { $ref: '#/$defs/notifier' } };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ship-kit monitor configuration',
    ...top,
    $defs: {
      check: { oneOf: Object.entries(CHECK_SCHEMAS).map(([t, s]) => objectSchema(s, t)) },
      notifier: { oneOf: Object.entries(NOTIFIER_SCHEMAS).map(([t, s]) => objectSchema(s, t)) },
    },
  };
}

if (process.argv[1]?.endsWith("schema.ts")) process.stdout.write(JSON.stringify(toJsonSchema(), null, 2) + '\n');
