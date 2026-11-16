#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.ts';
import { buildStatus, loadState, runOnce, serveStatus, type StatusDoc } from './monitor.ts';
import { systemClock } from './types.ts';

const USAGE = `ship-kit monitor

  watch     --config FILE [--once] [--dry-run]   run the checks (loop, or once for cron)
  validate  --config FILE                        check the config file and exit
  self-test --config FILE                        run every check once and print the alerts it would
                                                 send, including a synthetic one; sends nothing

Exit codes: 0 all ok | 1 a check is warn/crit (--once) | 2 bad config or usage
Config is YAML (a documented subset) or JSON. See examples/monitor.yaml.`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printResults(results: Array<{ status: string; name: string; message: string }>): void {
  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name}: ${r.message}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  if (!['watch', 'validate', 'self-test'].includes(cmd)) {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    return 2;
  }
  const file = arg(rest, '--config');
  if (!file) {
    console.error('--config FILE is required');
    return 2;
  }
  let cfg;
  try {
    cfg = loadConfig(file);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : String(e));
    return 2;
  }
  if (cmd === 'validate') {
    console.log(`config ok: ${cfg.checks.length} check(s), ${cfg.notifiers.length} notifier(s)`);
    return 0;
  }

  if (cmd === 'self-test') {
    console.log(`self-test for "${cfg.name}": running ${cfg.checks.length} check(s); nothing will be sent\n`);
    const rep = await runOnce(cfg, { dryRun: true, synthetic: true });
    printResults(rep.results);
    console.log(`\n${rep.alerts.length} alert(s) would be sent (dry run assumes failAfter=1 and no history)`);
    return 0;
  }

  const once = rest.includes('--once');
  const dry = rest.includes('--dry-run');
  if (once || dry) {
    const rep = await runOnce(cfg, { dryRun: dry });
    printResults(rep.results);
    for (const a of rep.alerts) if (!dry) console.log(`alert sent: ${a.kind} ${a.check}`);
    for (const e of rep.deliveryErrors) console.error(`delivery failed: ${e}`);
    if (dry) console.log(`\n${rep.alerts.length} alert(s) would be sent`);
    return rep.overall === 'ok' ? 0 : 1;
  }

  // long-running mode
  let latest: StatusDoc | null = null;
  const server = cfg.serve ? await serveStatus(cfg.serve.host, cfg.serve.port, () => latest) : null;
  if (server) console.log(`status page on http://${cfg.serve!.host}:${cfg.serve!.port}/status.json`);
  let stop = false;
  const onSig = () => {
    stop = true;
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  console.log(`watching "${cfg.name}" every ${cfg.intervalSeconds}s (Ctrl-C to stop)`);
  while (!stop) {
    const started = Date.now();
    try {
      const rep = await runOnce(cfg);
      latest = buildStatus(cfg, rep.results, loadState(cfg.stateFile), systemClock.now());
      const bad = rep.results.filter((r) => r.status !== 'ok');
      console.log(`${new Date().toISOString()} overall=${rep.overall}${bad.length ? ' ' + bad.map((b) => `${b.name}=${b.status}`).join(' ') : ''}`);
      for (const e of rep.deliveryErrors) console.error(`delivery failed: ${e}`);
    } catch (e) {
      console.error(`run failed: ${(e as Error).message}`);
    }
    const wait = Math.max(0, cfg.intervalSeconds * 1000 - (Date.now() - started));
    for (let waited = 0; waited < wait && !stop; waited += 250) await new Promise((r) => setTimeout(r, Math.min(250, wait - waited)));
  }
  server?.close();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
