#!/usr/bin/env node
/**
 * Read or set the lean preset's compaction knobs on THIS machine, by editing
 * `$DSH_HOME/.env`. Nothing here touches the installed bundle, so a machine can
 * change its trigger without reinstalling or rebuilding anything.
 *
 *   node scripts/set-compaction.mjs --show
 *   node scripts/set-compaction.mjs --threshold 0.2 --retain 0.02
 *   node scripts/set-compaction.mjs --unset
 *
 * With neither knob set the preset imposes no policy and the harness defaults
 * apply, which is what this script prints as the baseline.
 *
 * Usage: node scripts/set-compaction.mjs [--threshold <ratio>] [--retain <ratio>]
 *                                        [--unset] [--show] [--profile web]
 *                                        [--home <dir>] [--install <dsh package dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from './lib.mjs';

// A piped reader that closes early (`| head`) must not turn into an unhandled
// EPIPE crash: exit quietly instead, the way a shell tool should.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const home = L.resolveDshHome(option('home'));
const envFile = join(home, '.env');
const installDir = L.resolveInstallDir(option('install'));
const harness = L.installedCompactionDefaults(installDir);

/** Parse a ratio argument, rejecting anything the expression would reject. */
function ratio(name, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got ${JSON.stringify(raw)}`);
  if (name === 'threshold' && !(value > 0 && value <= 1)) throw new Error(`--threshold must be in (0, 1], got ${value}`);
  if (name === 'retain' && !(value > 0)) throw new Error(`--retain must be positive, got ${value}`);
  return value;
}

/** `$DSH_HOME/.env` as an ordered key/value view, preserving comments and order. */
function readEnvFile() {
  if (!existsSync(envFile)) return { lines: [], values: new Map() };
  const lines = readFileSync(envFile, 'utf8').split('\n');
  const values = new Map();
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (match !== null) values.set(match[1], match[2]);
  }
  return { lines, values };
}

let threshold;
let retain;
try {
  threshold = option('threshold') === undefined ? undefined : ratio('threshold', option('threshold'));
  retain = option('retain') === undefined ? undefined : ratio('retain', option('retain'));
  if (threshold !== undefined && retain !== undefined && !(retain < threshold)) {
    throw new Error(`--retain (${retain}) must be less than --threshold (${threshold})`);
  }
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(2);
}

const { lines, values } = readEnvFile();
const current = (key) => values.get(key);

/** Re-read `.env` so the report below reflects what was just written. */
function currentOnDisk(key) {
  return readEnvFile().values.get(key);
}

if (!flag('show') && !flag('unset')) mkdirSync(home, { recursive: true });

if (flag('show')) {
  process.stdout.write(`${envFile}\n`);
  for (const key of L.ENV_KEYS) process.stdout.write(`  ${key}=${current(key) ?? '(unset)'}\n`);
} else if (flag('unset')) {
  const kept = lines.filter((line) => !L.ENV_KEYS.some((key) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'u').test(line)));
  writeFileSync(envFile, kept.join('\n'));
  process.stdout.write(`cleared ${L.ENV_KEYS.join(' and ')} in ${envFile}; the preset falls back to the harness defaults\n`);
} else {
  if (threshold === undefined && retain === undefined) {
    process.stderr.write('nothing to do: pass --threshold and/or --retain, or --unset / --show\n');
    process.exit(2);
  }
  // Refuse a policy the plugin would reject at activation, before writing it to
  // disk: a retained tail at or above the trigger fails the whole preset mount,
  // so the machine would be left with a preset that cannot compose a session.
  const candidate = L.resolvePolicy(harness, {
    thresholdRatio: threshold ?? (current(L.THRESHOLD_ENV) === undefined ? undefined : Number(current(L.THRESHOLD_ENV))),
    retainRatio: retain ?? (current(L.RETAIN_ENV) === undefined ? undefined : Number(current(L.RETAIN_ENV)))
  });
  const models = L.collectProfileModels({ profile: option('profile') ?? 'web', home, installDir });
  const broken = models.models.map((model) => [model, L.compactSpec(model, candidate)]).find(([, spec]) => spec.error !== undefined && spec.error.includes('retainTokens'));
  if (broken !== undefined) {
    const [model, spec] = broken;
    process.stderr.write(`error: this policy would fail at activation on ${model.label}: ${spec.error}\n`);
    process.stderr.write(`       pass --retain as well, for example --retain ${Number((candidate.thresholdRatio / 8).toPrecision(3))}\n`);
    process.exit(2);
  }
  const next = new Map([[L.THRESHOLD_ENV, threshold ?? current(L.THRESHOLD_ENV)], [L.RETAIN_ENV, retain ?? current(L.RETAIN_ENV)]]);
  const kept = lines.filter((line) => !L.ENV_KEYS.some((key) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'u').test(line)));
  while (kept.length > 0 && kept.at(-1).trim() === '') kept.pop();
  for (const [key, value] of next) if (value !== undefined) kept.push(`${key}=${value}`);
  writeFileSync(envFile, `${kept.join('\n')}\n`);
  process.stdout.write(`updated ${envFile}\n`);
  for (const key of L.ENV_KEYS) process.stdout.write(`  ${key}=${currentOnDisk(key) ?? '(unset)'}\n`);
  process.stdout.write('restart `dsh web` for a new session to pick this up\n');
}

/** What the preset resolves right now: the knobs in `.env` over the harness defaults. */
const fromEnv = {};
for (const key of L.ENV_KEYS) {
  const raw = currentOnDisk(key);
  if (raw === undefined || raw.trim() === '') continue;
  fromEnv[key] = raw;
}
const resolved = L.resolvePolicy(harness, L.withEnv(fromEnv, () => L.evaluateExpression({ process }, L.EXPRESSION)));

process.stdout.write('\neffective policy for this machine:\n');
process.stdout.write(`  harness defaults  ratio ${harness.thresholdRatio} / retain ${harness.retainRatio}, headroom ${harness.headroomTokens} tokens\n`);
process.stdout.write(`  resolved now      ratio ${resolved.thresholdRatio} / retain ${resolved.retainRatio}${Object.keys(fromEnv).length === 0 ? '  (no override: harness defaults)' : ''}\n`);
const models = L.collectProfileModels({ profile: option('profile') ?? 'web', home, installDir });
if (models.note !== undefined) process.stdout.write(`  ${models.note}\n`);
process.stdout.write(`${L.formatSpecTable([['resolved now', resolved]], models.models)}\n`);
