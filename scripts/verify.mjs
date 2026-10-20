#!/usr/bin/env node
/**
 * Prove the generated bundle before it is installed or upgraded:
 *
 *   1. `cordis.patch.yml` is exactly the generator's output for the installed
 *      shipped presets;
 *   2. the preset is the shipped `minimal` declaration with exactly three
 *      declared changes -- the two description edits, the native filesystem
 *      mask, and the compaction group -- and nothing else, and no other row
 *      drifted;
 *   3. DSH's own dump/parse dialect round-trips the `!!js` markers;
 *   4. the injected compaction expression yields the documented policy table
 *      and refuses invalid values;
 *   5. the filesystem mask is a real `@deepseek-ai/dsh-tool-fs` Config, so the
 *      masked tools are never registered.
 *
 * Finally it prints the effective compaction numbers for this profile's models.
 *
 * Usage: node scripts/verify.mjs [--install <dsh package dir>]
 *                               [--minimal <minimal.patch.yml>] [--standard <standard.patch.yml>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
const minimal = L.readEntryList(tools, minimalSource);
const standard = L.readEntryList(tools, standardSource);
const writtenPath = join(root, 'cordis.patch.yml');
const writtenText = readFileSync(writtenPath, 'utf8');
const written = L.readEntryList(tools, writtenPath);
const expected = L.buildPatchList(minimal, standard);

let failed = 0;
function check(label, body) {
  try {
    body();
    process.stdout.write(`  ok    ${label}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL  ${label}\n          ${error.message}\n`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
/** Trim `!!js` sources so a dump that adds a trailing newline still compares equal. */
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === '__jsExpr' && typeof value === 'string' ? value.trim() : normalize(value);
    }
    return out;
  }
  return node;
}
function same(a, b, message) {
  assert(isDeepStrictEqual(normalize(a), normalize(b)), message);
}
/** Every `{__jsExpr}` marker under one node. */
function jsExprs(node, found = []) {
  if (Array.isArray(node)) for (const child of node) jsExprs(child, found);
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '__jsExpr') found.push(value);
      else jsExprs(value, found);
    }
  }
  return found;
}
/** Every plugin row of a preset, including nested group configs. */
function allRows(rows, found = []) {
  for (const row of rows ?? []) {
    found.push(row);
    if (Array.isArray(row.config)) allRows(row.config, found);
  }
  return found;
}

const standardPreset = L.findInsertedRow(standard, L.SOURCE_PRESET_ROW_ID);
const compactionGroup = L.findPlugin(standardPreset.config.plugins, L.COMPACTION_GROUP_ROW_ID);
const expectedMinimal = L.minimalPluginsWithEdits(minimal);
const presetRows = L.insertedRows(written);

/** The mask variant one inserted preset row declares. */
function variantOf(row) {
  const variant = L.MASK_VARIANTS.find((candidate) => L.presetRowId(candidate.key) === row.id);
  assert(variant !== undefined, `no mask variant declares the row id ${JSON.stringify(row.id)}`);
  return variant;
}

/** The tool a native filesystem Config flag switches. */
const TOOL_OF_FLAG = Object.fromEntries(
  Object.entries(L.FS_CONFIG_FLAGS).map(([tool, flag]) => [flag, tool])
);

check('cordis.patch.yml is exactly the generator output', () => {
  same(written, expected, 'the written patch differs from buildPatchList(); run `node scripts/sync.mjs`');
});

check('one patch entry, one inserted preset per mask variant', () => {
  assert(written.length === 1, `expected one patch entry, found ${written.length}`);
  assert(Object.keys(written[0]).join(',') === 'insert', `the patch entry carries more than insert: ${Object.keys(written[0]).join(',')}`);
  assert(presetRows.length === L.MASK_VARIANTS.length, `expected ${L.MASK_VARIANTS.length} preset rows, found ${presetRows.length}`);
});

check('no agent-preset-registry patch (coexists with other preset bundles)', () => {
  const touched = [...written, ...written.flatMap((entry) => entry.insert ?? [])].some((row) => row?.id === 'agent-preset-registry');
  assert(!touched, 'this bundle must not patch the preset registry: another bundle may own the profile default');
  assert(!writtenText.includes('id: agent-preset-registry'), 'agent-preset-registry appears in the generated file');
});

check('each preset row declares its id, display name, description and order', () => {
  for (const variant of L.MASK_VARIANTS) {
    const row = presetRows.find((candidate) => candidate.id === L.presetRowId(variant.key));
    assert(row !== undefined, `no inserted row ${L.presetRowId(variant.key)}`);
    assert(row.name === L.PRESET_PLUGIN_NAME, `${row.id} mounts ${row.name}`);
    assert(row.config?.id === variant.key, `${row.id} declares preset id ${JSON.stringify(row.config?.id)}`);
    assert(row.config?.name === variant.name, `${row.id} declares name ${JSON.stringify(row.config?.name)}`);
    assert(row.config?.description === variant.description, `${row.id} declares description ${JSON.stringify(row.config?.description)}`);
    assert(row.config?.order === L.PRESET_ORDER, `${row.id} declares order ${JSON.stringify(row.config?.order)}`);
  }
});

check('plugin row ids are unique inside each preset', () => {
  for (const row of presetRows) {
    const ids = allRows(row.config.plugins).map((plugin) => plugin.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert(duplicates.length === 0, `${row.id} repeats ${duplicates.join(', ')}`);
  }
});

check('the preset is the shipped minimal preset plus only the declared changes', () => {
  for (const row of presetRows) {
    const plugins = row.config.plugins;
    assert(
      plugins.length === expectedMinimal.length,
      `${row.id} carries ${plugins.length} rows, expected the shipped minimal's ${expectedMinimal.length}: nothing may be appended to it`
    );
    for (const [index, expected] of expectedMinimal.entries()) {
      const actual = plugins[index];
      assert(actual.id === expected.id, `${row.id} row ${index} is ${actual.id}, expected ${expected.id}`);
      if (expected.id === L.FS_ROW_ID) {
        // The filesystem row: only its config differs -- the native mask.
        const want = { ...expected, config: L.fsConfigFor(variantOf(row)) };
        same(actual, want, `${row.id}: the ${L.FS_ROW_ID} row drifted beyond the declared mask`);
        continue;
      }
      if (expected.id === L.COMPACTION_GROUP_ROW_ID) {
        // The compaction group: replaced by the shipped standard group, with
        // only the policy expression injected.
        const want = structuredClone(compactionGroup);
        L.findPlugin(want.config, L.COMPACTION_ROW_ID).config = { __jsExpr: L.EXPRESSION };
        same(actual, want, `${row.id}: the ${L.COMPACTION_GROUP_ROW_ID} group drifted from the shipped standard group`);
        continue;
      }
      same(actual, expected, `${row.id}: the ${expected.id} row drifted from the shipped minimal preset`);
    }
  }
});

check('the compaction group is the shipped standard group with only the policy expression replaced', () => {
  const want = structuredClone(compactionGroup);
  L.findPlugin(want.config, L.COMPACTION_ROW_ID).config = { __jsExpr: L.EXPRESSION };
  for (const row of presetRows) {
    same(L.findPlugin(row.config.plugins, L.COMPACTION_GROUP_ROW_ID), want, `${row.id}: the compaction group drifted from the shipped standard group`);
  }
});

check('the filesystem mask is a real tool-fs Config that switches the denied tools off', () => {
  for (const row of presetRows) {
    const variant = variantOf(row);
    const { resolved, source } = L.installedFsConfig(installDir, L.fsConfigFor(variant));
    for (const [flag, value] of Object.entries(resolved)) {
      const tool = TOOL_OF_FLAG[flag];
      if (tool === undefined) continue;
      const denied = variant.deny.includes(tool);
      assert(
        value === !denied,
        `${row.id}: ${source} resolves ${flag} to ${value}, but ${tool} is ${denied ? 'denied' : 'kept'}`
      );
    }
    assert(resolved.read === false, `${row.id}: read must be switched off`);
    assert(resolved.readImage === true, `${row.id}: read_image must stay on -- it is the tool this preset exists for`);
    assert(resolved.write === false, `${row.id}: write must be switched off`);
    assert(resolved.edit === false, `${row.id}: edit must be switched off`);
  }
});

check('the compaction expression ships no policy and reads only its own two knobs', () => {
  const eval_ = (env) => L.withEnv(env, () => L.evaluateExpression({ process }, L.EXPRESSION));
  // Nothing set: an empty object, so every field falls through to the harness.
  same(eval_({}), {}, 'an unset preset must impose no compaction policy');
  // The other bundle's machine-wide knobs must not reach this preset.
  for (const key of L.FOREIGN_ENV_KEYS) {
    same(eval_({ [key]: '0.001' }), {}, `${key} must not configure the lean preset`);
  }
  // Each knob sets itself alone, leaving the other to the harness default.
  same(eval_({ [L.THRESHOLD_ENV]: '0.2' }), { thresholdRatio: 0.2 }, 'threshold override');
  same(eval_({ [L.RETAIN_ENV]: '0.05' }), { retainRatio: 0.05 }, 'retain override');
  same(eval_({ [L.THRESHOLD_ENV]: '0.2', [L.RETAIN_ENV]: '0.01' }), { thresholdRatio: 0.2, retainRatio: 0.01 }, 'both knobs');
  same(eval_({ [L.THRESHOLD_ENV]: '0.002' }), { thresholdRatio: 0.002 }, 'a tiny threshold');
  same(eval_({ [L.THRESHOLD_ENV]: '   ' }), {}, 'a blank knob counts as unset');
  for (const env of [{ [L.THRESHOLD_ENV]: '0' }, { [L.THRESHOLD_ENV]: '1.5' }, { [L.THRESHOLD_ENV]: 'nope' }, { [L.RETAIN_ENV]: '0' }, { [L.RETAIN_ENV]: '-1' }, { [L.THRESHOLD_ENV]: '0.1', [L.RETAIN_ENV]: '0.2' }]) {
    let threw = false;
    try {
      eval_(env);
    } catch {
      threw = true;
    }
    assert(threw, `${JSON.stringify(env)} was accepted but should be rejected`);
  }
});

check('the shipped expression bakes in no ratio', () => {
  const literal = L.EXPRESSION.match(/\d*\.\d+/u);
  assert(literal === null, `the expression carries the numeric literal ${literal?.[0]}: a compaction policy must not be baked in`);
  for (const key of [L.THRESHOLD_ENV, L.RETAIN_ENV]) {
    assert(L.EXPRESSION.includes(key), `the expression does not read ${key}`);
  }
  for (const key of L.FOREIGN_ENV_KEYS) {
    assert(!L.EXPRESSION.includes(key), `the expression reads ${key}, which belongs to another bundle`);
  }
});

check('the preset defers to the installed compaction defaults', () => {
  const defaults = L.installedCompactionDefaults(installDir);
  assert(Number.isFinite(defaults.thresholdRatio) && Number.isFinite(defaults.retainRatio), `cannot read the harness compaction defaults from ${defaults.source}`);
  assert(defaults.headroomTokens > 0, 'cannot read the harness headroom default');
  const policy = L.resolvePolicy(defaults, L.withEnv({}, () => L.evaluateExpression({ process }, L.EXPRESSION)));
  same(
    { thresholdRatio: policy.thresholdRatio, retainRatio: policy.retainRatio, headroomTokens: policy.headroomTokens },
    { thresholdRatio: defaults.thresholdRatio, retainRatio: defaults.retainRatio, headroomTokens: defaults.headroomTokens },
    'an unset preset must resolve exactly the harness defaults'
  );
});

check('the preset ships no bundle-local plugin: the mask is the shipped native switch', () => {
  for (const row of presetRows) {
    for (const plugin of allRows(row.config.plugins)) {
      assert(
        !plugin.name.startsWith('dsh-lean-preset/'),
        `${row.id} mounts the bundle-local ${plugin.name}; the mask is the shipped tool-fs Config`
      );
    }
  }
  assert(!writtenText.includes('dsh-lean-preset/'), 'the generated file still names a bundle-local plugin');
});

check('the generated file carries exactly the expected !!js tags', () => {
  for (const row of presetRows) {
    const exprs = jsExprs(row.config.plugins);
    const platform = exprs.filter((expr) => expr.includes('process.platform')).length;
    const policy = exprs.filter((expr) => expr.includes('thresholdRatio')).length;
    assert(platform === 4, `${row.id}: expected four platform gates, found ${platform}`);
    assert(policy === 1, `${row.id}: expected one policy expression, found ${policy}`);
    assert(exprs.length === 5, `${row.id}: expected five !!js tags, found ${exprs.length}`);
  }
  assert(!jsExprs(L.findPlugin(presetRows[0].config.plugins, L.GATE_ROW_ID)).length, 'the gate row must stay literal');
});

check('the background bullets became the nohup / Start-Process recipe', () => {
  for (const row of presetRows) {
    const bash = L.findPlugin(row.config.plugins, 'persistent-bash').config.description;
    const pwsh = L.findPlugin(row.config.plugins, 'persistent-pwsh').config.description;
    assert(bash.includes('nohup'), 'the bash description does not mention nohup');
    assert(!bash.includes("'sleep 10 &'"), 'the bash description still advertises the dropped background feature');
    assert(pwsh.includes('Start-Process'), 'the pwsh description does not mention Start-Process');
    assert(!pwsh.includes("'Start-Job'"), 'the pwsh description still advertises the dropped background feature');
  }
});

check('the persona keeps minimal behaviour (complete prompt, no runtime context)', () => {
  const upstreamPersona = L.findPlugin(L.findInsertedRow(minimal, L.UPSTREAM_PRESET_ROW_ID).config.plugins, 'persona').config;
  for (const row of presetRows) {
    const persona = L.findPlugin(row.config.plugins, 'persona').config;
    same(persona, upstreamPersona, `${row.id}: the persona drifted from the shipped minimal persona`);
    assert(persona.complete === true, `${row.id}: persona.complete must stay true for a one-line prompt`);
    assert(persona.includeRuntimeContext === false, `${row.id}: persona.includeRuntimeContext must stay false`);
  }
});

check('every mounted package resolves in the installed DSH', () => {
  for (const row of presetRows) {
    for (const plugin of allRows(row.config.plugins)) {
      const name = plugin.name;
      if (name.startsWith('cordis:') || name.startsWith('.')) continue;
      tools.require.resolve(`${name}/package.json`);
    }
  }
});

check('upstream.json stamps the installed presets and version', () => {
  const stamp = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'));
  assert(stamp.dshVersion === L.dshVersion(installDir), `stamped dsh ${stamp.dshVersion}, installed ${L.dshVersion(installDir)}`);
  assert(stamp.sources.minimal.sha256 === L.sha256(readFileSync(minimalSource, 'utf8')), 'the minimal preset changed since this file was generated');
  assert(stamp.sources.standard.sha256 === L.sha256(readFileSync(standardSource, 'utf8')), 'the standard preset changed since this file was generated');
});

check('the mask names real tools of the shipped filesystem package', () => {
  const names = L.packageToolNames(installDir, L.FS_PACKAGE);
  assert(names.includes(L.KEPT_TOOL_NAME), `${L.FS_PACKAGE} no longer registers ${L.KEPT_TOOL_NAME}: the preset would expose nothing`);
  for (const variant of L.MASK_VARIANTS) {
    for (const name of variant.deny) {
      assert(names.includes(name), `${L.FS_PACKAGE} registers no ${JSON.stringify(name)}; a deny list with an unknown name fails at the first session`);
    }
    assert(!variant.deny.includes(L.KEPT_TOOL_NAME), `${variant.key} denies the tool it exists to expose`);
    for (const name of variant.deny) {
      assert(name in L.FS_CONFIG_FLAGS, `the shipped ${L.FS_PACKAGE} has no per-tool flag for ${JSON.stringify(name)}`);
    }
  }
});

const READMES = [
  { file: 'README.md', other: 'README.zh.md', upgrade: '## Upgrade' },
  { file: 'README.zh.md', other: 'README.md', upgrade: '## 升级' }
];

/** Maintainer-facing material belongs in MAINTAINING.md, not in the user README. */
const README_BANNED = [
  '本机',
  '维护与发版',
  'Maintenance and release',
  'MASK_VARIANTS',
  'HARNESS_COMPACTION_THRESHOLD_RATIO'
];

check('every README documents the shipped version, the tools and the upgrade path', () => {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  for (const { file, other, upgrade } of READMES) {
    const path = join(root, file);
    assert(existsSync(path), `${file} is missing`);
    const text = readFileSync(path, 'utf8');
    assert(text.includes(`#v${version}`), `${file} does not carry the install spec for v${version}`);
    assert(text.includes(L.KEPT_TOOL_NAME), `${file} does not name the kept tool`);
    assert(text.includes('nohup'), `${file} does not document the nohup recipe the dropped background tools leave behind`);
    assert(text.includes('轻量'), `${file} does not name the preset card users must pick`);
    assert(text.includes(`](${other})`), `${file} does not link ${other}`);
    assert(text.includes(upgrade), `${file} does not carry the upgrade section ${JSON.stringify(upgrade)}`);
  }
});

check('the READMEs stay user-facing and structurally parallel', () => {
  const headings = [];
  for (const { file } of READMES) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const token of README_BANNED) {
      assert(!text.includes(token), `${file} carries maintainer-only content ${JSON.stringify(token)}`);
    }
    headings.push(text.match(/^## /gmu)?.length ?? 0);
  }
  assert(headings[0] === headings[1] && headings[0] >= 8, `the two READMEs list ${headings.join(' and ')} top-level sections; they must match and cover the user path`);
});

check('MAINTAINING.md keeps the workflow the READMEs no longer carry', () => {
  const path = join(root, 'MAINTAINING.md');
  assert(existsSync(path), 'MAINTAINING.md is missing');
  const text = readFileSync(path, 'utf8');
  for (const token of ['sync.mjs', 'verify.mjs', 'check.mjs', 'DESCRIPTION_EDITS', 'MASK_VARIANTS']) {
    assert(text.includes(token), `MAINTAINING.md does not cover ${token}`);
  }
});

check('the operator script parses and reads its knobs from lib.mjs', () => {
  const script = join(root, 'scripts', 'set-compaction.mjs');
  execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' });
  const source = readFileSync(script, 'utf8');
  assert(source.includes("from './lib.mjs'"), 'set-compaction.mjs must import the shared constants');
  assert(source.includes('L.ENV_KEYS'), 'set-compaction.mjs must iterate L.ENV_KEYS');
  for (const key of [...L.ENV_KEYS, ...L.FOREIGN_ENV_KEYS]) {
    assert(!source.includes(key), `set-compaction.mjs hardcodes ${key}; take it from L.ENV_KEYS so one rename reaches every script`);
  }
});

check('budget.json records the measured request overhead', () => {
  const file = join(root, 'budget.json');
  if (!existsSync(file)) return;
  const budget = JSON.parse(readFileSync(file, 'utf8'));
  const names = budget.tools.map((tool) => tool.name).sort();
  assert(isDeepStrictEqual(names, ['bash', L.KEPT_TOOL_NAME].sort()), `budget.json measured ${names.join(', ')}`);
  assert(budget.totalTokens <= 400, `budget.json measures ${budget.totalTokens} tokens of request overhead; the lean preset must stay under 400`);
});

process.stdout.write(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}\n`);

process.stdout.write('\ncompaction policy this preset resolves:\n');
const models = L.collectProfileModels({ profile: option('profile') ?? 'web', installDir });
if (models.note !== undefined) process.stdout.write(`  (${models.note})\n`);
const harnessDefaults = L.installedCompactionDefaults(installDir);
const shipped = L.resolvePolicy(harnessDefaults, L.withEnv({}, () => L.evaluateExpression({ process }, L.EXPRESSION)));
process.stdout.write(`  harness defaults from ${harnessDefaults.source}\n`);
process.stdout.write(`    ratio ${harnessDefaults.thresholdRatio} / retain ${harnessDefaults.retainRatio}, headroom ${harnessDefaults.headroomTokens} tokens\n`);
process.stdout.write(`${L.formatSpecTable([
  ['shipped (no override)', shipped],
  [`${L.THRESHOLD_ENV}=0.2`, L.resolvePolicy(harnessDefaults, { thresholdRatio: 0.2 })],
  [`${L.THRESHOLD_ENV}=0.001`, L.resolvePolicy(harnessDefaults, { thresholdRatio: 0.001, retainRatio: 0.0005 })]
], models.models)}\n`);
for (const missing of models.missing) process.stdout.write(`  warning: ${missing.label} ${missing.reason}\n`);
process.stdout.write(`note: this preset reads only ${L.THRESHOLD_ENV} / ${L.RETAIN_ENV};\n`);
process.stdout.write('      dsh-compaction-tune\'s HARNESS_COMPACTION_* knobs do not reach it.\n');

process.exit(failed === 0 ? 0 : 1);
