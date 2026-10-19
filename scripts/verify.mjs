#!/usr/bin/env node
/**
 * Prove the generated bundle before it is installed or upgraded:
 *
 *   1. `cordis.patch.yml` is exactly the generator's output for the installed
 *      shipped presets;
 *   2. the preset is the shipped `minimal` declaration plus the shipped
 *      `standard` compaction and filesystem rows plus one gate row -- nothing
 *      else, and no other row drifted;
 *   3. DSH's own dump/parse dialect round-trips the `!!js` markers;
 *   4. the injected compaction expression yields the documented policy table
 *      and refuses invalid values;
 *   5. `gate/index.js` loads under plain node and gates exactly the agents it
 *      promises to.
 *
 * Finally it prints the effective compaction numbers for this profile's models.
 *
 * Usage: node scripts/verify.mjs [--install <dsh package dir>]
 *                               [--minimal <minimal.patch.yml>] [--standard <standard.patch.yml>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const fsRow = L.findPlugin(standardPreset.config.plugins, L.FS_ROW_ID);
const expectedMinimal = L.minimalPluginsWithEdits(minimal);
const presetRows = L.insertedRows(written);

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

check('leading rows are the shipped minimal preset plus only the declared description edits', () => {
  for (const row of presetRows) {
    const plugins = row.config.plugins;
    same(plugins.slice(0, expectedMinimal.length), expectedMinimal, `${row.id} drifted from the shipped minimal preset`);
    assert(plugins.length === expectedMinimal.length + 3, `${row.id} carries ${plugins.length} rows, expected ${expectedMinimal.length + 3}`);
  }
});

check('the added rows are exactly the compaction group, the tool-fs row and the gate row', () => {
  for (const row of presetRows) {
    const plugins = row.config.plugins;
    same(plugins.at(-2), fsRow, `${row.id}: the tool-fs row is not the shipped standard row`);
    assert(plugins.at(-1).id === L.GATE_ROW_ID, `${row.id}: the last row is ${plugins.at(-1).id}`);
    assert(plugins.at(-3).id === L.COMPACTION_GROUP_ROW_ID, `${row.id}: the compaction group is not where it is expected`);
  }
});

check('the compaction group is the shipped standard group with only the policy expression replaced', () => {
  const want = structuredClone(compactionGroup);
  L.findPlugin(want.config, L.COMPACTION_ROW_ID).config = { __jsExpr: L.EXPRESSION };
  for (const row of presetRows) {
    same(L.findPlugin(row.config.plugins, L.COMPACTION_GROUP_ROW_ID), want, `${row.id}: the compaction group drifted from the shipped standard group`);
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

check('the gate row names the bundle plugin and uses the variant mask', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const variant of L.MASK_VARIANTS) {
    const row = presetRows.find((candidate) => candidate.id === L.presetRowId(variant.key));
    const gate = L.findPlugin(row.config.plugins, L.GATE_ROW_ID);
    assert(gate.name === L.GATE_ROW_NAME, `${row.id}: gate mounts ${JSON.stringify(gate.name)}`);
    assert(gate.name.startsWith(`${manifest.name}/`), `the gate specifier must be rooted at the bundle package ${manifest.name}`);
    assert(existsSync(join(root, gate.name.slice(manifest.name.length + 1))), `${gate.name} does not exist inside the bundle`);
    assert(gate.config.preset === variant.key, `${row.id}: gate is bound to preset ${JSON.stringify(gate.config.preset)}`);
    same(gate.config.deny, variant.deny, `${row.id}: gate deny list drifted`);
    assert(gate.config.scope === variant.scope, `${row.id}: gate scope is ${JSON.stringify(gate.config.scope)}`);
  }
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

check('every mounted package resolves: shipped ones in dsh, this bundle beside the profile', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const row of presetRows) {
    for (const plugin of allRows(row.config.plugins)) {
      const name = plugin.name;
      if (name.startsWith('cordis:') || name.startsWith('.')) continue;
      if (name === manifest.name || name.startsWith(`${manifest.name}/`)) {
        const subpath = name === manifest.name ? '.' : `./${name.slice(manifest.name.length + 1)}`;
        const relative = subpath === '.' ? 'index.js' : subpath.slice(2);
        assert(existsSync(join(root, relative)), `${name} names no file inside the bundle (${relative})`);
        if (manifest.exports !== undefined) {
          assert(manifest.exports[subpath] !== undefined, `package.json exports does not expose ${subpath}`);
        }
        continue;
      }
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

let gateModule;
let gateError;
try {
  gateModule = await import(pathToFileURL(join(root, 'gate', 'index.js')).href);
} catch (error) {
  gateError = error.message;
}

check('gate/index.js loads under plain node and exports the plugin contract', () => {
  assert(gateModule !== undefined, `gate/index.js failed to import: ${gateError}`);
  assert(gateModule.name === L.GATE_ROW_ID, `gate name is ${JSON.stringify(gateModule.name)}`);
  assert(Array.isArray(gateModule.inject) && gateModule.inject.includes('tools'), 'gate does not declare the tools injection');
  assert(typeof gateModule.apply === 'function', 'gate exports no apply');
});

/** A context/agent pair that records what the gate registers, without DSH. */
function harness(presets = { s1: 'lean', s2: 'lean', s3: 'lean', s4: 'standard' }) {
  const listeners = new Map();
  const state = { restrictions: [], lifted: 0, gates: [] };
  const ctx = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    agentPresets: {
      composedPreset: (agentCtx) => agentCtx.preset
    }
  };
  const agent = (depth, id, preset = presets[id] ?? 'lean') => ({
    session: { id, header: { delegationDepth: depth } },
    ctx: {
      preset,
      effect: (body) => body(),
      tools: {
        restrict: (filter) => {
          state.restrictions.push(filter);
          return () => {
            state.lifted += 1;
          };
        }
      }
    }
  });
  return {
    state,
    ctx,
    fire: (event, payload) => {
      for (const fn of listeners.get(event) ?? []) fn(payload, () => Promise.resolve({}));
    },
    agent,
    next: () => Promise.resolve({})
  };
}

check('the gate restricts a root agent with the configured mask', () => {
  const h = harness();
  gateModule.apply(h.ctx, { preset: 'lean', deny: ['read', 'write', 'edit'], scope: 'root' });
  h.fire('agent/created', { agent: h.agent(0, 's1') });
  assert(h.state.restrictions.length === 1, `expected one restriction, found ${h.state.restrictions.length}`);
  same(h.state.restrictions[0].deny, ['read', 'write', 'edit'], 'the deny list did not reach restrict()');
  assert(h.state.restrictions[0].allow === undefined, 'a deny-only gate must not set allow');
});

check('the pre-step hook gates an agent created before the preset was mounted', () => {
  const h = harness();
  gateModule.apply(h.ctx, { preset: 'lean', deny: ['read'], scope: 'root' });
  // No agent/created for this agent: it existed before the preset was mounted.
  const agent = h.agent(0, 's2');
  h.fire('agent/pre-step', { agent });
  assert(h.state.restrictions.length === 1, 'the pre-step hook did not gate the agent');
  h.fire('agent/pre-step', { agent });
  assert(h.state.restrictions.length === 1, 'the pre-step hook must be idempotent');
});

check('the inbox-claim hook gates before a step is assembled', () => {
  const h = harness();
  gateModule.apply(h.ctx, { preset: 'lean', deny: ['read'], scope: 'root' });
  h.fire('agent/inbox/claimed', { agent: h.agent(0, 's3') });
  assert(h.state.restrictions.length === 1, 'the inbox-claim hook did not gate the agent');
});

check('the gate leaves agents of another preset alone', () => {
  const h = harness();
  gateModule.apply(h.ctx, { preset: 'lean', deny: ['read'], scope: 'root' });
  h.fire('agent/pre-step', { agent: h.agent(0, 's4') });
  h.fire('agent/created', { agent: h.agent(0, 's4') });
  assert(h.state.restrictions.length === 0, 'the gate touched an agent bound to another preset');
});

check('scope root spares delegated children; scope all gates them', () => {
  const root = harness();
  gateModule.apply(root.ctx, { preset: 'lean', deny: ['read'], scope: 'root' });
  root.fire('agent/created', { agent: root.agent(1, 's1') });
  assert(root.state.restrictions.length === 0, 'scope root must not gate a delegated child');

  const all = harness();
  gateModule.apply(all.ctx, { preset: 'lean', deny: ['read'], scope: 'all' });
  all.fire('agent/created', { agent: all.agent(1, 's1') });
  assert(all.state.restrictions.length === 1, 'scope all must gate a delegated child');
});

check('the gate lifts its restriction on disposal and on unload', () => {
  const h = harness();
  const dispose = gateModule.apply(h.ctx, { preset: 'lean', deny: ['read'], scope: 'root' });
  h.fire('agent/created', { agent: h.agent(0, 's1') });
  h.fire('agent/disposed', { agent: h.agent(0, 's1') });
  assert(h.state.lifted === 1, `disposal lifted ${h.state.lifted} restrictions, expected 1`);
  h.fire('agent/created', { agent: h.agent(0, 's2') });
  dispose();
  assert(h.state.lifted === 2, `unload lifted ${h.state.lifted} restrictions, expected 2`);
});

check('the gate refuses a configuration that hides nothing or names no preset', () => {
  const base = { preset: 'lean', scope: 'root' };
  for (const config of [undefined, {}, { ...base, deny: [] }, { ...base, deny: [''] }, { ...base, deny: ['read'], allow: [] }, { deny: ['read'] }, { ...base, preset: '' }, { ...base, deny: ['read'], scope: 'children' }]) {
    let threw = false;
    try {
      gateModule.apply(harness().ctx, config);
    } catch {
      threw = true;
    }
    assert(threw, `${JSON.stringify(config)} was accepted but should be rejected`);
  }
});

check('the gate mask names real tools of the shipped filesystem package', () => {
  const names = L.packageToolNames(installDir, L.FS_PACKAGE);
  assert(names.includes(L.KEPT_TOOL_NAME), `${L.FS_PACKAGE} no longer registers ${L.KEPT_TOOL_NAME}: the preset would expose nothing`);
  for (const variant of L.MASK_VARIANTS) {
    for (const name of variant.deny) {
      assert(names.includes(name), `${L.FS_PACKAGE} registers no ${JSON.stringify(name)}; a deny list with an unknown name fails at the first session`);
    }
    assert(!variant.deny.includes(L.KEPT_TOOL_NAME), `${variant.key} denies the tool it exists to expose`);
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
