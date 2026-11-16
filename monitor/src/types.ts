export type Status = 'ok' | 'warn' | 'crit';

export interface Clock {
  now(): number; // epoch milliseconds
}
export const systemClock: Clock = { now: () => Date.now() };

export interface CheckResult {
  name: string;
  type: string;
  status: Status;
  message: string;
  /** Optional numeric reading (latency ms, days left, percent used, age hours...) */
  value?: number;
  unit?: string;
}

export type Alertkind = 'alert' | 'recovery' | 'reminder' | 'flapping' | 'stable';

export interface Alert {
  kind: Alertkind;
  check: string;
  status: Status;
  message: string;
  /** epoch ms of the state change this alert is about */
  since: number;
  /** values to restore if delivery failed everywhere, so the alert is retried next run */
  retry: { lastNotifiedStatus: Status | null; lastNotifiedAt: number };
}

export interface CheckState {
  confirmed: Status;
  pending: { status: Status; count: number } | null;
  since: number;
  lastNotifiedStatus: Status | null;
  lastNotifiedAt: number;
  transitions: number[];
  flapping: boolean;
  lastMessage: string;
}
export type EngineState = Record<string, CheckState>;

export interface AlertingConfig {
  failAfter: number;
  recoverAfter: number;
  repeatMinutes: number;
  flap: { threshold: number; windowMinutes: number };
}
