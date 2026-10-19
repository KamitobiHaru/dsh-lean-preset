#!/usr/bin/env node
/**
 * Measure what one session's request actually costs: the tool schemas in its
 * `request/header`, the system prompt the model received, and the runtime
 * context snapshots in history.
 *
 * The arithmetic matches DSH's own estimator (`@deepseek-ai/dsh-token-meter`
 * prices text at four characters per token plus small block overhead), so these
 * numbers are comparable with the `contextBreakdown` projection, but they are
 * estimates: CJK text and JSON schemas underprice at four characters per token.
 *
 * History is not measured. A session's real context is dominated by accumulated
 * messages, which only compaction can reduce.
 *
 * Usage:
 *   node scripts/measure.mjs [--preset lean] [--session <id|file.zstd>]
 *                            [--home ~/.dsh] [--json] [--write-budget [path]]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = argv[index + 1];
  return next === undefined || next.startsWith('--') ? '' : next;
};
const flag = (name) => argv.includes(`--${name}`);

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decompress one session log. DSH appends each flush as its own zstd frame, so
 * a single `zstdDecompressSync` call would return only the first one: this
 * walks the magic numbers and concatenates every frame. `zstdcat` is used when
 * it exists because it is exact; the frame walk is the portable fallback (37/37
 * frames and 79/79 lines on the sample that motivated it).
 */
export function readSessionLog(file) {
  try {
    return execFileSync('zstdcat', [file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch {
    // fall through to the frame walk
  }
  const buf = readFileSync(file);
  const parts = [];
  let offset = buf.indexOf(ZSTD_MAGIC);
  while (offset >= 0 && offset < buf.length) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offset)));
    } catch {
      // not a frame start: a magic number inside compressed bytes
    }
    offset = buf.indexOf(ZSTD_MAGIC, offset + 4);
  }
  if (parts.length === 0) throw new Error(`cannot decompress ${file}: no zstd frame decoded`);
  return Buffer.concat(parts).toString('utf8');
}

/** Every path under `root` whose basename is `session.v4.jsonl.zstd`, newest first. */
function sessionLogs(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'session.v4.jsonl.zstd') found.push(path);
    }
  };
  walk(root);
  return found
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.path);
}

/** Parse a decompressed log into events, skipping anything unreadable. */
export function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // a torn trailing line: the durable prefix is what matters
    }
  }
  return events;
}

const tokens = (chars) => Math.round(chars / 4);

/** Fold one parsed session into the measurement this script reports. */
export function analyse(events, file) {
  const header = events.find((event) => event.type === 'session');
  const headers = events.filter((event) => event.type === 'request/header');
  const first = headers[0]?.data?.header;
  const context = [...events].reverse().find((event) => event.type === 'request/context')?.data;
  const prompts = events.filter((event) => event.type === 'system/message');
  const prompt = prompts.at(-1)?.data?.message;
  const promptText = (prompt?.content ?? []).map((block) => block.text ?? '').join('\n\n');
  const runtimeContext = events
    .filter((event) => event.type === 'user/message' && event.data?.message?.source?.kind === 'runtime-context')
    .map((event) => (event.data.message.content ?? []).map((block) => block.text ?? JSON.stringify(block)).join(''));

  const tools = (first?.tools ?? []).map((tool) => {
    const chars = JSON.stringify(tool).length;
    return { name: tool.name, chars, tokens: tokens(chars) };
  });
  tools.sort((a, b) => b.chars - a.chars);

  const preset = [...events].reverse().find((event) => event.type === 'agent-preset/selected')?.data?.agentPreset ?? header?.agentPreset;
  const route = first?.config;
  const model = route === undefined
    ? undefined
    : {
        provider: route.provider,
        model: route.model,
        maxTokens: route.maxTokens,
        contextWindow: context?.contextWindow
      };

  const toolChars = tools.reduce((sum, tool) => sum + tool.chars, 0);
  const promptChars = promptText.length;
  const contextChars = runtimeContext.reduce((sum, text) => sum + text.length, 0);
  const totalChars = toolChars + promptChars + contextChars;

  return {
    file,
    sessionId: header?.id,
    preset,
    cwd: header?.cwd,
    route: model,
    toolCount: tools.length,
    tools,
    toolChars,
    toolTokens: tokens(toolChars),
    promptParts: (prompt?.content ?? []).length,
    promptChars,
    promptTokens: tokens(promptChars),
    promptText,
    promptUpdates: Math.max(0, prompts.length - 1),
    runtimeContextCount: runtimeContext.length,
    runtimeContextChars: contextChars,
    runtimeContextTokens: tokens(contextChars),
    totalChars,
    totalTokens: tokens(totalChars),
    headers: headers.length
  };
}

/**
 * The policy this bundle's preset resolves right now: the two knobs over the
 * harness defaults, plus the resulting trigger/retention for one route.
 */
function policyFor(model) {
  if (model?.contextWindow === undefined) return undefined;
  let defaults;
  try {
    defaults = L.installedCompactionDefaults(L.resolveInstallDir());
  } catch (error) {
    return { note: `cannot read the harness compaction defaults: ${error.message}` };
  }
  const partial = L.withEnv({}, () => L.evaluateExpression({ process }, L.EXPRESSION));
  const policy = L.resolvePolicy(defaults, partial);
  return {
    ...policy,
    overridden: Object.keys(partial).length > 0,
    spec: L.compactSpec({ label: `${model.provider}/${model.model}`, contextWindow: model.contextWindow, reservedCompletionTokens: model.maxTokens }, policy)
  };
}

function report(measured, policy) {
  const lines = [];
  lines.push(`session  ${measured.sessionId ?? '(unknown)'}  preset ${measured.preset ?? '(none)'}  cwd ${measured.cwd ?? '(none)'}`);
  lines.push(`source   ${measured.file}`);
  if (measured.route !== undefined) {
    lines.push(`route    ${measured.route.provider}/${measured.route.model}  contextWindow ${measured.route.contextWindow ?? '(unrecorded)'}  maxTokens ${measured.route.maxTokens ?? '(none)'}`);
  }
  if (policy !== undefined) {
    if (policy.note !== undefined) lines.push(`compact  ${policy.note}`);
    else lines.push(`compact  trigger ${policy.spec.thresholdTokens} tokens, retain ${policy.spec.retainTokens ?? '?'} tokens (ratio ${policy.thresholdRatio} / ${policy.retainRatio}, ${policy.spec.binding ?? policy.spec.error}${policy.overridden ? ', overridden by HARNESS_LEAN_*' : ', harness defaults'})`);
  }
  lines.push('');
  lines.push(`tools (${measured.toolCount})  ${measured.toolChars} chars  ~${measured.toolTokens} tokens`);
  for (const tool of measured.tools) lines.push(`  ${String(tool.tokens).padStart(6)} ${String(tool.chars).padStart(7)}  ${tool.name}`);
  lines.push('');
  lines.push(`system prompt  ${measured.promptChars} chars  ~${measured.promptTokens} tokens  (${measured.promptUpdates} later update${measured.promptUpdates === 1 ? '' : 's'} in history)`);
  for (const paragraph of measured.promptText.split(/\n{2,}/).filter((text) => text.trim() !== '')) {
    lines.push(`  ${String(tokens(paragraph.length)).padStart(6)} ${String(paragraph.length).padStart(7)}  ${JSON.stringify(paragraph.length > 70 ? `${paragraph.slice(0, 67)}...` : paragraph)}`);
  }
  lines.push('');
  lines.push(`runtime context  ${measured.runtimeContextCount} snapshot(s)  ${measured.runtimeContextChars} chars  ~${measured.runtimeContextTokens} tokens (history)`);
  lines.push('');
  lines.push(`request overhead  ~${measured.totalTokens} tokens  (tools + prompt + runtime context)`);
  return lines.join('\n');
}

const home = L.resolveDshHome(option('home'));
const explicit = option('session');
const preset = option('preset');
let file;
if (explicit !== undefined && explicit !== '') {
  file = existsSync(explicit) ? explicit : join(home, 'sessions', explicit, 'session.v4.jsonl.zstd');
  if (!existsSync(file)) {
    const hit = sessionLogs(join(home, 'sessions')).find((path) => path.includes(explicit));
    if (hit === undefined) throw new Error(`no session log matches ${JSON.stringify(explicit)} under ${home}`);
    file = hit;
  }
} else {
  const logs = sessionLogs(join(home, 'sessions'));
  if (logs.length === 0) throw new Error(`no session logs under ${join(home, 'sessions')}`);
  if (preset === undefined) file = logs[0];
  else {
    file = logs.find((path) => {
      try {
        const events = parseEvents(readSessionLog(path));
        const header = events.find((event) => event.type === 'session');
        const selected = [...events].reverse().find((event) => event.type === 'agent-preset/selected')?.data?.agentPreset;
        return (selected ?? header?.agentPreset) === preset;
      } catch {
        return false;
      }
    });
    if (file === undefined) throw new Error(`no session log records preset ${JSON.stringify(preset)} under ${home}`);
  }
}

const measured = analyse(parseEvents(readSessionLog(file)), file);
const policy = policyFor(measured.route);

if (flag('json')) {
  const { promptText, ...rest } = measured;
  process.stdout.write(`${JSON.stringify({ ...rest, policy, promptText }, null, 2)}\n`);
} else {
  process.stdout.write(`${report(measured, policy)}\n`);
}

if (flag('write-budget')) {
  const index = argv.indexOf('--write-budget');
  const target = argv[index + 1] !== undefined && !argv[index + 1].startsWith('--') ? argv[index + 1] : join(import.meta.dirname, '..', 'budget.json');
  const { promptText, file: _source, ...rest } = measured;
  writeFileSync(target, `${JSON.stringify({ measuredAt: new Date().toISOString(), dshVersion: L.dshVersion(L.resolveInstallDir()), ...rest, policy }, null, 2)}\n`);
  process.stdout.write(`wrote ${target}\n`);
}
