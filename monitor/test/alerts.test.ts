import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, revertUndelivered } from '../src/alerts.ts';
import type { AlertingConfig, CheckResult, EngineState, Status } from '../src/types.ts';
import { FakeClock } from './helpers.ts';

const cfg: AlertingConfig = { failAfter: 2, recoverAfter: 2, repeatMinutes: 60, flap: { threshold: 4, windowMinutes: 30 } };
const res = (status: Status, message = status): CheckResult => ({ name: 'db', type: 'x', status, message });

/** Runs a sequence of readings one minute apart, returning the kinds of alerts after each. */
function drive(seq: Status[], c: AlertingConfig = cfg, stepMin = 1): { kinds: string[][]; state: EngineState; clock: FakeClock } {
  const clock = new FakeClock();
  let state: EngineState = {};
  const kinds: string[][] = [];
  for (const s of seq) {
    const r = evaluate(state, [res(s)], clock.now(), c);
    state = r.state;
    kinds.push(r.alerts.map((a) => a.kind));
    clock.minutes(stepMin);
  }
  return { kinds, state, clock };
}

test('a single bad reading alerts nobody (flap damping)', () => {
  const { kinds } = drive(['ok', 'crit', 'ok', 'ok', 'ok']);
  assert.deepEqual(kinds.flat(), []);
});

test('alerts after failAfter consecutive bad readings, exactly once (de-duplication)', () => {
  const { kinds } = drive(['crit', 'crit', 'crit', 'crit', 'crit']);
  assert.deepEqual(kinds, [[], ['alert'], [], [], []]);
});

test('recovery needs recoverAfter good readings and is sent once', () => {
  const { kinds } = drive(['crit', 'crit', 'ok', 'ok', 'ok']);
  assert.deepEqual(kinds, [[], ['alert'], [], ['recovery'], []]);
});

test('a bad blip during recovery resets the recovery count', () => {
  const { kinds } = drive(['crit', 'crit', 'ok', 'crit', 'ok', 'ok']);
  assert.deepEqual(kinds, [[], ['alert'], [], [], [], ['recovery']]);
});

test('no recovery message for a problem nobody was told about', () => {
  const { kinds } = drive(['crit', 'ok', 'crit', 'ok', 'ok', 'ok']);
  assert.deepEqual(kinds.flat(), []);
});

test('a still-broken check is repeated as a reminder only every repeatMinutes', () => {
  const { kinds } = drive(Array(125).fill('crit') as Status[]);
  const flat = kinds.map((k, i) => (k.length ? `${i}:${k[0]}` : '')).filter(Boolean);
  assert.deepEqual(flat, ['1:alert', '61:reminder', '121:reminder']);
});

test('repeatMinutes: 0 never reminds', () => {
  const { kinds } = drive(Array(300).fill('crit') as Status[], { ...cfg, repeatMinutes: 0 });
  assert.equal(kinds.flat().length, 1);
});

test('warn escalating to crit sends a second alert; crit easing to warn sends an update', () => {
  const { kinds } = drive(['warn', 'warn', 'crit', 'crit', 'warn', 'warn']);
  assert.deepEqual(kinds, [[], ['alert'], [], ['alert'], [], ['alert']]);
});

test('flapping: one notice, then silence, then one "stable" notice', () => {
  // alternate in pairs so every status change is confirmed (failAfter=recoverAfter=2)
  const flappy: Status[] = [];
  for (let i = 0; i < 6; i++) flappy.push(...(['crit', 'crit', 'ok', 'ok'] as Status[]));
  const c: AlertingConfig = { ...cfg, flap: { threshold: 4, windowMinutes: 30 } };
  const { kinds, state, clock } = drive(flappy, c);
  const all = kinds.flat();
  assert.equal(all.filter((k) => k === 'flapping').length, 1, `got ${all.join(',')}`);
  assert.ok(state.db.flapping);
  // after the flapping stops and the window passes, one stable notice and no more
  let st = state;
  const later: string[] = [];
  for (let i = 0; i < 40; i++) {
    const r = evaluate(st, [res('ok')], clock.now(), c);
    st = r.state;
    later.push(...r.alerts.map((a) => a.kind));
    clock.minutes(1);
  }
  assert.deepEqual(later, ['stable']);
  assert.equal(st.db.flapping, false);
});

test('undelivered alerts are retried on the next run, delivered ones are not', () => {
  const clock = new FakeClock();
  let state: EngineState = {};
  state = evaluate(state, [res('crit')], clock.now(), cfg).state;
  clock.minutes(1);
  const first = evaluate(state, [res('crit')], clock.now(), cfg);
  assert.equal(first.alerts.length, 1);
  revertUndelivered(first.state, first.alerts); // nobody accepted it
  clock.minutes(1);
  const second = evaluate(first.state, [res('crit')], clock.now(), { ...cfg, repeatMinutes: 0 });
  assert.deepEqual(second.alerts.map((a) => a.kind), ['alert'], 'retried even with reminders off');
  clock.minutes(1);
  const third = evaluate(second.state, [res('crit')], clock.now(), { ...cfg, repeatMinutes: 0 });
  assert.equal(third.alerts.length, 0, 'delivered, so quiet');
});

test('an undelivered recovery is retried too', () => {
  const clock = new FakeClock();
  let state = drive(['crit', 'crit'], cfg).state;
  clock.minutes(5);
  state = evaluate(state, [res('ok')], clock.now(), cfg).state;
  clock.minutes(1);
  const rec = evaluate(state, [res('ok')], clock.now(), cfg);
  assert.deepEqual(rec.alerts.map((a) => a.kind), ['recovery']);
  revertUndelivered(rec.state, rec.alerts);
  clock.minutes(1);
  assert.deepEqual(evaluate(rec.state, [res('ok')], clock.now(), cfg).alerts.map((a) => a.kind), ['recovery']);
});

test('checks removed from the config disappear from the state', () => {
  const r = evaluate({}, [res('ok')], 0, cfg);
  const r2 = evaluate(r.state, [{ ...res('ok'), name: 'other' }], 1, cfg);
  assert.deepEqual(Object.keys(r2.state), ['other']);
});

test('checks are tracked independently', () => {
  const clock = new FakeClock();
  let state: EngineState = {};
  const kinds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = evaluate(state, [{ ...res('crit'), name: 'a' }, { ...res('ok'), name: 'b' }], clock.now(), cfg);
    state = r.state;
    kinds.push(...r.alerts.map((a) => `${a.check}:${a.kind}`));
    clock.minutes(1);
  }
  assert.deepEqual(kinds, ['a:alert']);
});
