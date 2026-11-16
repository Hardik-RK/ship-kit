// A deliberately small YAML subset parser so the monitor needs no dependencies.
// Supported: block mappings, block sequences ("- x", "- key: v" with continuation keys),
// plain/quoted scalars, numbers, booleans, null, "# comments", inline [a, b] lists and {k: v} maps.
// NOT supported: anchors/aliases, multi-line scalars (| >), tags, multi-document files, complex keys.
// If you need those, write the config as JSON instead.

interface Line {
  indent: number;
  text: string;
  no: number;
}

export class YamlError extends Error {}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === '[' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ']' || c === '}') {
      depth--;
      cur += c;
    } else if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur);
  return out;
}

function scalar(raw: string, no: number): unknown {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError(`line ${no}: unterminated double-quoted string`);
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlError(`line ${no}: bad escape in double-quoted string`);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(`line ${no}: unterminated single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError(`line ${no}: unterminated inline list`);
    return splitTop(s.slice(1, -1), ',').map((x) => scalar(x, no));
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError(`line ${no}: unterminated inline map`);
    const o: Record<string, unknown> = {};
    for (const part of splitTop(s.slice(1, -1), ',')) {
      const kv = splitKey(part.trim(), no);
      if (!kv) throw new YamlError(`line ${no}: expected key: value in inline map`);
      o[kv.key] = scalar(kv.rest, no);
    }
    return o;
  }
  if (/^[&*!]/.test(s) || /^[|>]( |$)/.test(s)) {
    throw new YamlError(`line ${no}: anchors, tags and block scalars are not supported (use JSON for those)`);
  }
  return s;
}

/** "key: rest" at top level (colon followed by a space or end of line), honouring quotes. */
function splitKey(s: string, no: number): { key: string; rest: string } | null {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (i === 0) q = c;
      continue;
    }
    if (c === '[' || c === '{') return null;
    if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ')) {
      const rawKey = s.slice(0, i).trim();
      const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? String(scalar(rawKey, no)) : rawKey;
      return { key, rest: s.slice(i + 1).trim() };
    }
  }
  return null;
}

export function parseYaml(text: string): unknown {
  const lines: Line[] = [];
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((l, i) => {
      if (/\t/.test(l.match(/^\s*/)![0])) throw new YamlError(`line ${i + 1}: tabs are not allowed for indentation`);
      const t = stripComment(l).replace(/\s+$/, '');
      if (t.trim() === '' || t.trim() === '---') return;
      lines.push({ indent: t.length - t.trimStart().length, text: t.trimStart(), no: i + 1 });
    });
  if (lines.length === 0) return null;
  let pos = 0;

  const isItem = (l: Line) => l.text.startsWith('- ') || l.text === '-';

  function block(indent: number): unknown {
    const first = lines[pos];
    if (first.indent !== indent) throw new YamlError(`line ${first.no}: unexpected indentation`);
    return isItem(first) ? seq(indent) : map(indent);
  }

  function nested(parentIndent: number): unknown {
    const next = lines[pos];
    return next && next.indent > parentIndent ? block(next.indent) : null;
  }

  function map(indent: number, seed?: Record<string, unknown>): Record<string, unknown> {
    const o: Record<string, unknown> = seed ?? {};
    while (pos < lines.length && lines[pos].indent === indent && !isItem(lines[pos])) {
      const ln = lines[pos++];
      const kv = splitKey(ln.text, ln.no);
      if (!kv) throw new YamlError(`line ${ln.no}: expected "key: value"`);
      if (Object.prototype.hasOwnProperty.call(o, kv.key)) throw new YamlError(`line ${ln.no}: duplicate key "${kv.key}"`);
      if (kv.rest !== '') {
        o[kv.key] = scalar(kv.rest, ln.no);
        continue;
      }
      const nx = lines[pos];
      // YAML allows a sequence at the same indent as its parent key
      if (nx && nx.indent === indent && isItem(nx)) o[kv.key] = seq(indent);
      else o[kv.key] = nested(indent);
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new YamlError(`line ${lines[pos].no}: unexpected indentation`);
    return o;
  }

  function seq(indent: number): unknown[] {
    const arr: unknown[] = [];
    while (pos < lines.length && lines[pos].indent === indent && isItem(lines[pos])) {
      const ln = lines[pos++];
      const rest = ln.text === '-' ? '' : ln.text.slice(2).trim();
      if (rest === '') {
        arr.push(nested(indent));
        continue;
      }
      const kv = splitKey(rest, ln.no);
      if (kv) {
        // "- key: v" opens a mapping; its other keys are indented to the column of "key"
        const keyIndent = indent + (ln.text.length - ln.text.slice(1).trimStart().length);
        const o: Record<string, unknown> = {};
        if (kv.rest !== '') o[kv.key] = scalar(kv.rest, ln.no);
        else o[kv.key] = nested(keyIndent);
        if (pos < lines.length && lines[pos].indent === keyIndent && !isItem(lines[pos])) map(keyIndent, o);
        arr.push(o);
      } else {
        arr.push(scalar(rest, ln.no));
      }
    }
    return arr;
  }

  const result = block(lines[0].indent);
  if (pos < lines.length) throw new YamlError(`line ${lines[pos].no}: unexpected content`);
  return result;
}
