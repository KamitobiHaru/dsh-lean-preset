/**
 * Shared helpers for the dsh-lean-preset bundle scripts.
 *
 * Every script loads DSH's own entry-list YAML dialect (`entryListSchema`) and
 * the installation's own `js-yaml`, so a generated patch round-trips exactly
 * the way the Cordis Loader reads it -- `!!js` markers included.
 *
 * The generator never invents plugin rows. The preset is the shipped `minimal`
 * declaration plus rows copied verbatim from the shipped `standard`
 * declaration, so an upstream change to those rows is a diff, not a silent
 * divergence.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Loader row id convention for an inserted preset declaration. */
export const PRESET_ROW_PREFIX = 'preset-';
/** This bundle's package name: the base for its own plugin specifier and for git installs. */
export const PACKAGE_NAME = 'dsh-lean-preset';
/** The shipped declaration this bundle derives from. */
export const UPSTREAM_PRESET_ROW_ID = 'preset-minimal';
export const UPSTREAM_PRESET_ID = 'minimal';
/** The shipped declaration the copied tool rows come from. */
export const SOURCE_PRESET_ROW_ID = 'preset-standard';
export const SOURCE_PRESET_ID = 'standard';
export const PRESET_PLUGIN_NAME = '@deepseek-ai/dsh-agent-preset';

/** Roster position; standard 1, ptc 2, minimal 3, cordis 4. */
export const PRESET_ORDER = 5;

/**
 * One shipped preset per tool mask. Each entry becomes its own declaration in
 * the same bundle, so the Web new-session picker is where a person chooses a
 * toolset; adding a toolset is one more entry here plus `sync.mjs`.
 *
 * `deny` is applied per agent by `gate/index.js` at `agent/created`, before the
 * session's first request. Only `@deepseek-ai/dsh-tool-fs` needs masking: it
 * registers read/write/edit/read_image as one row with no per-tool switch.
 */
export const MASK_VARIANTS = [
  {
    key: 'lean',
    name: '轻量',
    description: '极简模式加上自动压缩与图像读取。',
    deny: ['read', 'write', 'edit'],
    scope: 'root'
  }
];

/** Row id of one variant's declaration in the generated patch. */
export function presetRowId(key) {
  return PRESET_ROW_PREFIX + key;
}

/** The copied filesystem row whose extra tools the gate hides. */
export const FS_ROW_ID = 'tool-fs';
/** Package that owns read/write/edit/read_image; used by verification. */
export const FS_PACKAGE = '@deepseek-ai/dsh-tool-fs';
/** The tool this bundle exists to expose, kept for documentation and checks. */
export const KEPT_TOOL_NAME = 'read_image';
/** The shipped group row carrying the compaction tools, copied verbatim. */
export const COMPACTION_GROUP_ROW_ID = 'compaction';
export const COMPACTION_ROW_ID = 'compaction-basic';
export const PRUNER_ROW_ID = 'tool-result-pruner';
/** The bundle-shipped gate plugin row. */
export const GATE_ROW_ID = 'tool-gate';
/**
 * Module specifier for the gate plugin. It is the bundle's own package name
 * plus a subpath rather than `./gate/index.js`: a preset declaration's rows are
 * resolved against the PROFILE's base URL, not the patch file's directory, so a
 * relative specifier there names a file beside `cordis.patch.yml` in the
 * profile (where nothing exists). The bundle is a profile dependency, so its
 * package name resolves from that base.
 */
export const GATE_ROW_NAME = `${PACKAGE_NAME}/gate/index.js`;

/**
 * Compaction knobs for the lean preset.
 *
 * This bundle deliberately ships NO compaction policy: unset knobs fall through
 * to whatever the harness itself defaults to, so the preset follows the
 * deployment instead of imposing a trigger. These two names only exist so one
 * machine can raise or lower that trigger for this preset alone; they are
 * separate from `dsh-compaction-tune`'s `HARNESS_COMPACTION_*`, which keeps
 * that preset's aggressive tuning out of `/lean`.
 */
export const THRESHOLD_ENV = 'HARNESS_LEAN_COMPACTION_THRESHOLD_RATIO';
export const RETAIN_ENV = 'HARNESS_LEAN_COMPACTION_RETAIN_RATIO';
export const ENV_KEYS = [THRESHOLD_ENV, RETAIN_ENV];
/** Names this preset must ignore so it never inherits another bundle's policy. */
export const FOREIGN_ENV_KEYS = ['HARNESS_COMPACTION_THRESHOLD_RATIO', 'HARNESS_COMPACTION_RETAIN_RATIO', 'DSH_COMPACTION_THRESHOLD_RATIO', 'DSH_COMPACTION_RETAIN_RATIO'];

/**
 * The `!!js` expression this bundle injects into the preset's `compaction-basic`
 * row. It reads the two knobs above and returns only what they set; with
 * neither set it returns an empty object, which leaves every field to the
 * plugin's own defaults. So the effective policy is the harness's, and it
 * follows a DSH upgrade automatically.
 *
 * Only `0` and `1` appear as literals, and nothing else is numeric: `verify.mjs`
 * asserts that no ratio is baked in here.
 */
export const EXPRESSION = `(() => {
  const env = process.env;
  const read = (name) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error('compaction ' + name + ' must be a number, got ' + raw);
    return value;
  };
  const thresholdRatio = read('${THRESHOLD_ENV}');
  const retainRatio = read('${RETAIN_ENV}');
  if (thresholdRatio !== undefined && !(thresholdRatio > 0 && thresholdRatio <= 1)) {
    throw new Error('compaction threshold ratio must be in (0, 1], got ' + thresholdRatio + '; set ${THRESHOLD_ENV}');
  }
  if (retainRatio !== undefined && !(retainRatio > 0)) {
    throw new Error('compaction retain ratio must be positive, got ' + retainRatio + '; set ${RETAIN_ENV}');
  }
  if (thresholdRatio !== undefined && retainRatio !== undefined && !(retainRatio < thresholdRatio)) {
    throw new Error('compaction retain ratio must be less than the threshold ratio ' + thresholdRatio + ', got ' + retainRatio);
  }
  const policy = {};
  if (thresholdRatio !== undefined) policy.thresholdRatio = thresholdRatio;
  if (retainRatio !== undefined) policy.retainRatio = retainRatio;
  return policy;
})()`;

/** The Loader's own expression wrapper, so verification evaluates what DSH evaluates. */
export const evaluateExpression = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }');

/**
 * Minimal's bash/pwsh descriptions end with a "run it in the background"
 * bullet. This bundle drops the background-job tools, so those bullets become
 * the `nohup <cmd> ... &` + poll-the-log recipe instead. Each replacement must
 * match exactly once; a miss fails `sync.mjs` loudly rather than shipping a
 * preset that still tells the model to use a feature the preset does not have.
 */
export const DESCRIPTION_EDITS = [
  {
    rowId: 'persistent-bash',
    from: "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
    to: '* For long lived commands use `nohup <cmd> > /tmp/<name>.log 2>&1 &` and poll that log with tail/grep; never leave a foreground command waiting.'
  },
  {
    rowId: 'persistent-pwsh',
    from: "* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.",
    to: '* For long lived commands use `Start-Process -NoNewWindow -RedirectStandardOutput <log> <cmd>` and poll that log; never leave a foreground command waiting.'
  }
];

/** Absolute path of the dsh installation, from `which dsh` unless given. */
export function resolveInstallDir(explicit) {
  let dir;
  if (explicit !== undefined) dir = realpathSync(resolve(explicit));
  else {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    let bin;
    try {
      bin = execFileSync(finder, ['dsh'], { encoding: 'utf8' }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    } catch {
      throw new Error('cannot find the dsh CLI on PATH; pass --install <path of the installed @deepseek-ai/dsh package>');
    }
    if (bin === undefined) throw new Error('cannot find the dsh CLI on PATH; pass --install <path of the installed @deepseek-ai/dsh package>');
    const real = realpathSync(bin);
    dir = dirname(dirname(real));
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh') throw new Error(`${dir} is not the @deepseek-ai/dsh package (found ${JSON.stringify(manifest.name)})`);
  return dir;
}

/** dsh installation anchor plus the YAML dialect and parser that installation ships. */
export function loadDshTools(installDir) {
  const require = createRequire(join(installDir, 'package.json'));
  const yaml = require('js-yaml');
  const include = require('@deepseek-ai/cordis-plugin-include');
  if (include.entryListSchema === undefined) throw new Error('@deepseek-ai/cordis-plugin-include exports no entryListSchema');
  return { require, yaml, entryListSchema: include.entryListSchema, installDir };
}

/** One shipped preset patch file (`minimal` or `standard`). */
export function resolvePresetSource(installDir, preset, explicit) {
  if (explicit !== undefined) return resolve(explicit);
  const require = createRequire(join(installDir, 'package.json'));
  return join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets', `${preset}.patch.yml`);
}

export function dshVersion(installDir) {
  return JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version;
}

export function readEntryList(tools, file) {
  const data = tools.yaml.load(readFileSync(file, 'utf8'), { schema: tools.entryListSchema });
  if (!Array.isArray(data)) throw new Error(`${file} must hold a top-level YAML array of loader entries`);
  return data;
}

export function dumpEntryList(tools, data) {
  return tools.yaml.dump(data, { schema: tools.entryListSchema, noRefs: true, lineWidth: -1 });
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Every row inserted by the `insert:` patches of one entry list. */
export function insertedRows(entries) {
  const rows = [];
  for (const entry of entries) for (const row of entry?.insert ?? []) rows.push(row);
  return rows;
}

/** One inserted row by id. */
export function findInsertedRow(entries, rowId) {
  for (const row of insertedRows(entries)) if (row?.id === rowId) return row;
  throw new Error(`no inserted loader row has id ${JSON.stringify(rowId)}`);
}

/** One plugin row of a preset declaration, searched through nested group configs. */
export function findPlugin(rows, rowId) {
  for (const row of rows ?? []) {
    if (row?.id === rowId) return row;
    if (Array.isArray(row?.config)) {
      const hit = findPlugin(row.config, rowId);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Deep clone that keeps the Loader's `{__jsExpr}` markers intact. */
function clone(value) {
  return structuredClone(value);
}

/**
 * The minimal plugin rows exactly as this bundle ships them: a clone of the
 * shipped list with `DESCRIPTION_EDITS` applied. `verify.mjs` compares the
 * generated preset's leading rows against this, so any upstream change to the
 * minimal preset is a failure rather than a silent divergence.
 */
export function minimalPluginsWithEdits(minimalEntries) {
  const minimal = findInsertedRow(minimalEntries, UPSTREAM_PRESET_ROW_ID);
  if (minimal.config?.id !== UPSTREAM_PRESET_ID) {
    throw new Error(`${UPSTREAM_PRESET_ROW_ID} no longer declares preset id ${JSON.stringify(UPSTREAM_PRESET_ID)}`);
  }
  const rows = clone(minimal.config.plugins);
  applyDescriptionEdits(rows);
  return rows;
}

/** Apply the declared description edits to the copied minimal plugin rows. */
function applyDescriptionEdits(rows) {
  for (const edit of DESCRIPTION_EDITS) {
    const row = findPlugin(rows, edit.rowId);
    if (row === undefined) throw new Error(`the shipped minimal preset declares no ${edit.rowId} row to edit`);
    const text = row.config?.description;
    if (typeof text !== 'string') throw new Error(`${edit.rowId} carries no description string to edit`);
    const parts = text.split(edit.from);
    if (parts.length !== 2) {
      throw new Error(
        `${edit.rowId}: expected exactly one occurrence of the background bullet to replace, found ${parts.length - 1}.\n` +
          `  upstream text: ${JSON.stringify(text)}\n  looking for:   ${JSON.stringify(edit.from)}\n` +
          '  fix DESCRIPTION_EDITS in scripts/lib.mjs against the current shipped minimal preset.'
      );
    }
    row.config.description = parts[0] + edit.to + parts[1];
  }
}

/**
 * The complete patch list this bundle ships. `sync.mjs` writes exactly this and
 * `verify.mjs` asserts the written file still equals it.
 *
 * @param minimalEntries - parsed `presets/minimal.patch.yml`.
 * @param standardEntries - parsed `presets/standard.patch.yml`.
 */
export function buildPatchList(minimalEntries, standardEntries) {
  const minimal = findInsertedRow(minimalEntries, UPSTREAM_PRESET_ROW_ID);
  if (minimal.config?.id !== UPSTREAM_PRESET_ID) {
    throw new Error(`${UPSTREAM_PRESET_ROW_ID} no longer declares preset id ${JSON.stringify(UPSTREAM_PRESET_ID)}`);
  }
  const standard = findInsertedRow(standardEntries, SOURCE_PRESET_ROW_ID);
  if (standard.config?.id !== SOURCE_PRESET_ID) {
    throw new Error(`${SOURCE_PRESET_ROW_ID} no longer declares preset id ${JSON.stringify(SOURCE_PRESET_ID)}`);
  }

  const compactionGroup = findPlugin(standard.config.plugins, COMPACTION_GROUP_ROW_ID);
  if (compactionGroup === undefined) throw new Error(`the shipped standard preset declares no ${COMPACTION_GROUP_ROW_ID} group`);
  const fsRow = findPlugin(standard.config.plugins, FS_ROW_ID);
  if (fsRow === undefined) throw new Error(`the shipped standard preset declares no ${FS_ROW_ID} row`);

  const insert = MASK_VARIANTS.map((variant) => {
    const plugins = minimalPluginsWithEdits(minimalEntries);
    const compaction = clone(compactionGroup);
    const basic = findPlugin(compaction.config, COMPACTION_ROW_ID);
    if (basic === undefined) throw new Error(`the copied ${COMPACTION_GROUP_ROW_ID} group declares no ${COMPACTION_ROW_ID} row`);
    basic.config = { __jsExpr: EXPRESSION };
    plugins.push(compaction);
    plugins.push(clone(fsRow));
    plugins.push({
      id: GATE_ROW_ID,
      name: GATE_ROW_NAME,
      config: { preset: variant.key, deny: [...variant.deny], scope: variant.scope }
    });
    return {
      id: presetRowId(variant.key),
      name: PRESET_PLUGIN_NAME,
      config: {
        id: variant.key,
        name: variant.name,
        description: variant.description,
        order: PRESET_ORDER,
        plugins
      }
    };
  });

  // One patch entry only: this bundle never overrides `agent-preset-registry`,
  // so it cannot fight another preset bundle over the profile default.
  return [{ insert }];
}

/** Run `fn` with exactly the knobs set to `values`, restoring the process afterwards. */
export function withEnv(values, fn) {
  const keys = [...ENV_KEYS, ...FOREIGN_ENV_KEYS];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function resolveDshHome(explicit) {
  if (explicit !== undefined) return resolve(explicit);
  const fromEnv = process.env.DSH_HOME;
  return resolve(fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh'));
}

/**
 * Static tool names one shipped package registers, read from its built source.
 * Used to prove the gate's `deny` list names real tools without mounting.
 */
export function packageToolNames(installDir, packageName) {
  const require = createRequire(join(installDir, 'package.json'));
  const file = require.resolve(`${packageName}/package.json`);
  const source = readFileSync(join(dirname(file), 'lib', 'index.js'), 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/defineTool\(\{\s*name: "([A-Za-z0-9_]+)"/gu)) names.add(match[1]);
  return [...names];
}

/**
 * What the harness itself defaults to, read from the installed
 * `@deepseek-ai/dsh-compaction-basic` source: this is the "system policy" the
 * preset falls through to when neither knob is set. Read rather than hardcoded
 * so a DSH upgrade that changes them changes the printed table too.
 */
export function installedCompactionDefaults(installDir) {
  const require = createRequire(join(installDir, 'package.json'));
  const file = require.resolve('@deepseek-ai/dsh-compaction-basic/package.json');
  const source = readFileSync(join(dirname(file), 'lib', 'index.js'), 'utf8');
  const constant = (name) => {
    const match = source.match(new RegExp(`const ${name} = (-?[0-9.]+)`));
    return match === null ? undefined : Number(match[1]);
  };
  const headroom = source.match(/config\.headroomTokens \?\? ([0-9]+)/u);
  return {
    thresholdRatio: constant('DEFAULT_THRESHOLD_RATIO'),
    retainRatio: constant('DEFAULT_RETAIN_RATIO'),
    headroomTokens: headroom === null ? undefined : Number(headroom[1]),
    source: file
  };
}

/**
 * Sample routes, used only when no profile patch can be read. The printed table
 * is diagnostics: compaction-basic resolves the real numbers at runtime per
 * routed model, so these values never configure anything.
 */
export const FALLBACK_MODELS = [
  { label: 'opencode-go/deepseek-v4.1-flash', contextWindow: 1000000, reservedCompletionTokens: 384000 },
  { label: 'opencode-go/mimo-v2.6-flash', contextWindow: 1048576, reservedCompletionTokens: 131072 }
];

/**
 * Every model declared by one profile's own patch layer
 * (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), across all providers.
 */
export function collectProfileModels(options = {}) {
  const file = join(resolveDshHome(options.home), 'profiles', options.profile ?? 'web', 'cordis.patch.yml');
  if (!existsSync(file)) return { file, models: [], missing: [], note: `no profile patch at ${file}` };
  let entries;
  try {
    const tools = loadDshTools(options.installDir ?? resolveInstallDir());
    entries = readEntryList(tools, file);
  } catch (error) {
    return { file, models: [], missing: [], note: `cannot read the profile patch: ${error.message}` };
  }
  const models = [];
  const missing = [];
  const visit = (rows) => {
    for (const row of rows ?? []) {
      const providers = row?.config?.providers;
      if (providers !== null && typeof providers === 'object') {
        for (const [provider, providerConfig] of Object.entries(providers)) {
          for (const model of providerConfig?.models ?? []) {
            const label = `${provider}/${model?.id ?? '?'}`;
            if (typeof model?.contextWindow !== 'number') {
              missing.push({ label, reason: 'declares no contextWindow, so compaction throws TargetPressureConfigError on this route' });
              continue;
            }
            models.push({
              label,
              contextWindow: model.contextWindow,
              reservedCompletionTokens: typeof model.maxTokens === 'number' ? model.maxTokens : undefined
            });
          }
        }
      }
      if (Array.isArray(row?.config)) visit(row.config);
      if (Array.isArray(row?.insert)) visit(row.insert);
    }
  };
  visit(entries);
  return { file, models, missing };
}

/**
 * Mirror of `@deepseek-ai/dsh-compaction-basic`'s threshold/retention
 * arithmetic for one model and one resolved policy (ratios plus headroom).
 */
export function compactSpec(model, policy) {
  const { thresholdRatio, retainRatio, headroomTokens } = policy;
  const ratioTerm = model.contextWindow * thresholdRatio;
  if (model.reservedCompletionTokens === undefined) {
    return { thresholdTokens: Math.floor(ratioTerm), binding: 'ratio term only; maxTokens not declared' };
  }
  const messageBudgetTokens = model.contextWindow - model.reservedCompletionTokens;
  const pressureBudgetTokens = messageBudgetTokens - headroomTokens;
  if (pressureBudgetTokens <= 0) {
    return { error: `pressure budget <= 0 (${model.contextWindow} - ${model.reservedCompletionTokens} - ${headroomTokens}); TargetPressureConfigError at runtime` };
  }
  const thresholdTokens = Math.floor(Math.min(ratioTerm, pressureBudgetTokens));
  const retainTokens = Math.floor(messageBudgetTokens * retainRatio);
  if (retainTokens >= thresholdTokens) {
    return { error: `retainTokens ${retainTokens} >= thresholdTokens ${thresholdTokens}; compaction-basic refuses this policy at activation` };
  }
  return { thresholdTokens, retainTokens, binding: ratioTerm <= pressureBudgetTokens ? 'ratio' : 'headroom cap' };
}

/** One printed case: a label and the policy it resolves to. */
export function formatSpecTable(cases, models = FALLBACK_MODELS) {
  if (models.length === 0) return '  (no models)';
  const lines = [];
  for (const model of models) {
    const declared = model.reservedCompletionTokens === undefined ? 'maxTokens not declared' : `maxTokens ${model.reservedCompletionTokens}`;
    lines.push(`  ${model.label}  (contextWindow ${model.contextWindow}, ${declared})`);
    for (const [label, policy] of cases) {
      const spec = compactSpec(model, policy);
      const detail = spec.error !== undefined
        ? spec.error
        : spec.retainTokens === undefined
          ? `trigger <= ${spec.thresholdTokens} tokens (${spec.binding})`
          : `trigger ${spec.thresholdTokens} tokens, retain ${spec.retainTokens} tokens (${spec.binding})`;
      lines.push(`    ${label.padEnd(26)} ratio ${String(policy.thresholdRatio).padEnd(7)} retain ${String(policy.retainRatio).padEnd(8)} -> ${detail}`);
    }
  }
  return lines.join('\n');
}

/** Merge partial knob values over the harness defaults into one resolved policy. */
export function resolvePolicy(defaults, partial = {}) {
  return {
    thresholdRatio: partial.thresholdRatio ?? defaults.thresholdRatio,
    retainRatio: partial.retainRatio ?? defaults.retainRatio,
    headroomTokens: partial.headroomTokens ?? defaults.headroomTokens
  };
}
