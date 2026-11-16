import type { Alert, AlertingConfig, CheckResult, CheckState, EngineState } from './types.ts';

const MIN = 60_000;

export function newState(now: number): CheckState {
  return { confirmed: 'ok', pending: null, since: now, lastNotifiedStatus: null, lastNotifiedAt: 0, transitions: [], flapping: false, lastMessage: '' };
}

/**
 * Pure alerting state machine. Feed it one round of check results; it returns the alerts to send
 * and the next state. It never does I/O, so it is tested with a fake clock.
 *
 *  - flap damping:  a status change is only "confirmed" after failAfter (or recoverAfter)
 *                   consecutive observations of the new status. One blip alerts nobody.
 *  - de-duplication: a confirmed status notifies once; the same alert is repeated only as a
 *                   reminder every repeatMinutes (0 = never).
 *  - flap detection: if a check still changes confirmed status `flap.threshold` times within
 *                   `flap.windowMinutes`, send ONE "flapping" notice, then stay quiet until it
 *                   has been stable for the window, then send one "stable" notice.
 *  - recovery:      sent only if an alert was actually sent for the problem.
 */
export function evaluate(
  prev: EngineState,
  results: CheckResult[],
  now: number,
  cfg: AlertingConfig,
): { state: EngineState; alerts: Alert[] } {
  const state: EngineState = structuredClone(prev);
  const alerts: Alert[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    seen.add(r.name);
    const s = (state[r.name] ??= newState(now));
    s.lastMessage = r.message;
    const retry = { lastNotifiedStatus: s.lastNotifiedStatus, lastNotifiedAt: s.lastNotifiedAt };
    const push = (kind: Alert['kind'], message: string) => {
      alerts.push({ kind, check: r.name, status: s.confirmed, message, since: s.since, retry });
      s.lastNotifiedStatus = s.confirmed;
      s.lastNotifiedAt = now;
    };

    // 1. confirm status changes only after enough consecutive observations
    let changed = false;
    if (r.status === s.confirmed) {
      s.pending = null;
    } else {
      s.pending = s.pending && s.pending.status === r.status ? { status: r.status, count: s.pending.count + 1 } : { status: r.status, count: 1 };
      const need = r.status === 'ok' ? cfg.recoverAfter : cfg.failAfter;
      if (s.pending.count >= need) {
        s.confirmed = r.status;
        s.since = now;
        s.pending = null;
        s.transitions.push(now);
        changed = true;
      }
    }

    // 2. flap bookkeeping
    const windowMs = cfg.flap.windowMinutes * MIN;
    s.transitions = s.transitions.filter((t) => now - t < windowMs);
    if (!s.flapping && s.transitions.length >= cfg.flap.threshold) {
      s.flapping = true;
      push('flapping', `${r.name} changed status ${s.transitions.length} times in ${cfg.flap.windowMinutes} min; alerts are muted until it settles. Latest: ${r.status.toUpperCase()}: ${r.message}`);
      continue;
    }
    if (s.flapping) {
      if (s.transitions.length === 0) {
        s.flapping = false;
        push('stable', `${r.name} has settled: ${s.confirmed.toUpperCase()}: ${r.message}`);
      }
      continue; // muted while flapping
    }

    // 3. notify, de-duplicated
    // "owed": the confirmed status has not been told to anyone yet. This is also what retries an
    // alert whose delivery failed (revertUndelivered restores the old lastNotifiedStatus).
    const owed = s.confirmed === 'ok' ? s.lastNotifiedStatus !== null && s.lastNotifiedStatus !== 'ok' : s.lastNotifiedStatus !== s.confirmed;
    if (owed) {
      if (s.confirmed === 'ok') push('recovery', `${r.name} recovered: ${r.message}`);
      else push('alert', `${r.name}: ${r.message}`);
    } else if (changed && s.confirmed === 'ok') {
      s.lastNotifiedStatus = 'ok'; // never alerted, so there is nothing to recover from
    } else if (s.confirmed !== 'ok' && cfg.repeatMinutes > 0 && now - s.lastNotifiedAt >= cfg.repeatMinutes * MIN) {
      push('reminder', `${r.name} still ${s.confirmed.toUpperCase()} since ${new Date(s.since).toISOString()}: ${r.message}`);
    }
  }

  for (const k of Object.keys(state)) if (!seen.has(k)) delete state[k]; // check removed from config
  return { state, alerts };
}

/** If no notifier accepted an alert, undo its bookkeeping so it is tried again on the next run. */
export function revertUndelivered(state: EngineState, undelivered: Alert[]): void {
  for (const a of undelivered) {
    const s = state[a.check];
    if (!s) continue;
    s.lastNotifiedStatus = a.retry.lastNotifiedStatus;
    s.lastNotifiedAt = a.retry.lastNotifiedAt;
  }
}

export function overall(results: CheckResult[]): 'ok' | 'warn' | 'crit' {
  return results.some((r) => r.status === 'crit') ? 'crit' : results.some((r) => r.status === 'warn') ? 'warn' : 'ok';
}
