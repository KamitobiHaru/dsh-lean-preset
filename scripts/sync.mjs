#!/usr/bin/env node
/**
 * Regenerate `cordis.patch.yml` from the installed DSH's shipped presets.
 *
 * The declaration is the shipped `minimal` preset, verbatim, plus two copied
 * rows from the shipped `standard` preset (the compaction group and the
 * filesystem suite) and one bundle-local gate row. Nothing is hand-written
 * except the gate's `deny` list and the compaction expression.
 *
 * Usage: node scripts/sync.mjs [--install <dsh package dir>]
 *                             [--minimal <minimal.patch.yml>] [--standard <standard.patch.yml>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const root = join(import.meta.dirname, '..');
const installDir = L.resolveInstallDir(option('install'));
const tools = L.loadDshTools(installDir);
const minimalSource = L.resolvePresetSource(installDir, 'minimal', option('minimal'));
const standardSource = L.resolvePresetSource(installDir, 'standard', option('standard'));
const minimalText = readFileSync(minimalSource, 'utf8');
const standardText = readFileSync(standardSource, 'utf8');
const patches = L.buildPatchList(L.readEntryList(tools, minimalSource), L.readEntryList(tools, standardSource));
const version = L.dshVersion(installDir);
const variants = L.MASK_VARIANTS.map((variant) => variant.key).join(', ');

const header = [
  '# dsh-lean-preset - GENERATED FILE, do not hand-edit.',
  '#',
  '# Adds one @deepseek-ai/dsh-agent-preset row per tool mask (' + variants + '):',
  '# the shipped `minimal` preset, verbatim, plus the shipped `standard` preset\'s',
  '# compaction group (whose `' + L.COMPACTION_ROW_ID + '` row carries one `!!js` expression)',
  '# and filesystem row, plus the bundle\'s `' + L.GATE_ROW_ID + '` plugin.',
  '#',
  '# `' + L.GATE_ROW_ID + '` hides the tools that row registers together but this preset does',
  '# not want (' + L.MASK_VARIANTS.map((variant) => variant.deny.join('/')).join('; ') + '), per agent, before its first',
  '# request. That is why only `' + L.KEPT_TOOL_NAME + '` reaches the model.',
  '#',
  '# The compaction expression reads ' + L.THRESHOLD_ENV + ' and',
  '# ' + L.RETAIN_ENV + ' at boot and returns only what they set: with neither set,',
  '# this preset imposes no policy at all and the harness defaults apply, so a DSH',
  '# upgrade moves the preset with it. Set the knobs per machine in $DSH_HOME/.env',
  '# (see scripts/set-compaction.mjs); dsh-compaction-tune\'s HARNESS_COMPACTION_*',
  '# names deliberately do not reach this preset.',
  '#',
  '# This bundle never patches `agent-preset-registry`, so it cannot fight another',
  '# preset bundle over the profile default. Pick this preset per session, or set a',
  '# profile default yourself.',
  '#',
  '# source: @deepseek-ai/dsh-web-app/presets/minimal.patch.yml',
  '#         @deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  '# dsh:    ' + version,
  '# sha256: ' + L.sha256(minimalText) + '  (minimal)',
  '#         ' + L.sha256(standardText) + '  (standard)',
  '#',
  '# Regenerate with `node scripts/sync.mjs`; detect upstream drift with',
  '# `node scripts/check.mjs`; prove the result with `node scripts/verify.mjs`.',
  ''
].join('\n');

writeFileSync(join(root, 'cordis.patch.yml'), header + L.dumpEntryList(tools, patches));
writeFileSync(join(root, 'upstream.json'), `${JSON.stringify({
  dshVersion: version,
  sources: {
    minimal: { path: minimalSource, sha256: L.sha256(minimalText) },
    standard: { path: standardSource, sha256: L.sha256(standardText) }
  },
  generatedAt: new Date().toISOString()
}, null, 2)}\n`);

process.stdout.write(`wrote cordis.patch.yml for preset(s) ${variants}\n`);
process.stdout.write(`  dsh ${version}\n`);
process.stdout.write(`  minimal  ${L.sha256(minimalText).slice(0, 16)}...  ${minimalSource}\n`);
process.stdout.write(`  standard ${L.sha256(standardText).slice(0, 16)}...  ${standardSource}\n`);
