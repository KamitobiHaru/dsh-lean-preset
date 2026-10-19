#!/usr/bin/env node
/**
 * Report whether the installed DSH still ships the two preset files this
 * bundle was generated from. Exits non-zero on drift so a DSH upgrade is
 * noticed before the copied rows quietly fall behind.
 *
 * Usage: node scripts/check.mjs [--install <dsh package dir>]
 *                               [--minimal <minimal.patch.yml>] [--standard <standard.patch.yml>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const root = join(import.meta.dirname, '..');
const installDir = L.resolveInstallDir(option('install'));
const stamp = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'));
const version = L.dshVersion(installDir);

const sources = {
  minimal: L.resolvePresetSource(installDir, 'minimal', option('minimal')),
  standard: L.resolvePresetSource(installDir, 'standard', option('standard'))
};

process.stdout.write(`dsh: ${version}   (generated against ${stamp.dshVersion})\n`);
const drift = [];
for (const [name, path] of Object.entries(sources)) {
  const digest = L.sha256(readFileSync(path, 'utf8'));
  const expected = stamp.sources?.[name]?.sha256;
  process.stdout.write(`${name.padEnd(8)} ${digest}\n`);
  process.stdout.write(`${''.padEnd(8)} ${expected ?? '(unstamped)'}  stamped\n`);
  process.stdout.write(`${''.padEnd(8)} ${path}\n`);
  if (digest !== expected) drift.push(`${name}: the content of ${path} changed`);
}
if (version !== stamp.dshVersion) drift.push(`dsh ${stamp.dshVersion} -> ${version}`);

if (drift.length === 0) {
  process.stdout.write('\nup to date: the frozen preset still matches the shipped minimal and standard presets.\n');
  process.exit(0);
}
process.stderr.write('\nDRIFT: the shipped preset this bundle froze is no longer the installed one.\n');
for (const line of drift) process.stderr.write(`  ${line}\n`);
process.stderr.write('\nnext: node scripts/sync.mjs && git diff && node scripts/verify.mjs\n');
process.exit(1);
