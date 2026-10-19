/**
 * tool-gate - hide a fixed set of tools from the agents of one preset.
 *
 * Why this exists: an agent preset declares its tools by mounting plugin rows,
 * and several shipped tools arrive in one row (`@deepseek-ai/dsh-tool-fs`
 * registers `read`/`write`/`edit`/`read_image` together, with no per-tool
 * switch). A preset that wants only some of them hides the rest per agent
 * instead of re-implementing the ones it keeps.
 *
 * How: `ctx.tools.restrict()` on the AGENT's own context removes inherited
 * tools (the preset layer included). The same call on the preset's own context
 * would leave its sibling rows visible, because a restriction filters what a
 * scope inherits and never what its own layer registers. A hidden tool also
 * loses its own guidance section when that section checks visibility, which the
 * shipped filesystem tools do.
 *
 * When: the loop claims a step's input, dispatches `agent/inbox/claimed`, and
 * only THEN assembles the system prompt and tool schemas; `agent/pre-step`
 * follows that assembly. So the restriction has to land before a step is
 * assembled, and three hooks cover every composition order, each idempotent:
 *
 *  - `agent/created`: the ordinary path, where the preset was chosen before the
 *    agent was created and this listener therefore exists in time.
 *  - `agent/inbox/claimed`: a preset mounted onto an EXISTING blank agent
 *    (`agentPresets/select`, which the Web preset picker uses). That mount
 *    happens after `agent/created` was dispatched, so the listener above never
 *    sees the agent; the first turn's claim does, still before its assembly.
 *  - `agent/pre-step`: a safety net that corrects the next request if either
 *    earlier hook was missed. It cannot fix the request it runs in, because the
 *    schemas of that request are already assembled.
 *
 * Cost: none while idle. This plugin registers no tool and no prompt section.
 *
 * Deliberately dependency-free: it imports nothing. A bundle-installed plugin
 * cannot import the harness's own packages (resolution runs from the profile,
 * not the bundle), and a build-free plugin keeps this file readable by both the
 * Loader and a plain `node` process used for testing.
 *
 * @module dsh-lean-preset/gate
 */

/** Loader row name; the row id in the composing patch is what a profile targets. */
export const name = 'tool-gate';

/** The tool registry does the hiding; the preset registry says which agents are ours. */
export const inject = ['tools', 'agentPresets'];

/**
 * @param {object} config - row configuration.
 * @param {string} config.preset - preset id this gate belongs to; agents bound to
 *   any other preset are never touched.
 * @param {string[]} [config.deny] - tool names to hide from the gated agents.
 * @param {string[]} [config.allow] - tool names to keep; everything else hidden.
 * @param {'root'|'all'} [config.scope] - `root` (default) gates only top-level
 *   agents, so delegated children keep the full mounted set; `all` gates every
 *   agent under the preset.
 */
export function apply(ctx, config) {
  const preset = config?.preset;
  if (typeof preset !== 'string' || preset.trim() === '') {
    throw new Error('tool-gate: "preset" must name the preset id this gate belongs to');
  }
  const deny = readNames(config, 'deny');
  const allow = config?.allow === undefined ? undefined : readNames(config, 'allow');
  if (deny.length === 0 && allow === undefined) {
    throw new Error('tool-gate: configure at least one of "deny" or "allow" (an empty filter hides nothing)');
  }
  const scope = config?.scope ?? 'root';
  if (scope !== 'root' && scope !== 'all') {
    throw new Error(`tool-gate: scope must be "root" or "all", got ${JSON.stringify(scope)}`);
  }

  /** One agent's restriction disposer, so unload or disposal can lift it. */
  const held = new Map();

  const lift = (sessionId) => {
    const disposer = held.get(sessionId);
    held.delete(sessionId);
    if (disposer !== undefined) disposer();
  };

  const gate = (agent) => {
    const sessionId = agent.session.id;
    if (held.has(sessionId)) return;
    if (scope === 'root' && (agent.session.header?.delegationDepth ?? 0) !== 0) return;
    if (ctx.agentPresets.composedPreset(agent.ctx) !== preset) return;
    // The filter belongs to the agent, so it unwinds with the agent; the
    // disposer is kept here too because unloading this plugin does not dispose
    // an agent-scoped registration by itself.
    held.set(
      sessionId,
      agent.ctx.effect(() => agent.ctx.tools.restrict({ deny, allow }))
    );
  };

  ctx.on('agent/created', ({ agent }) => {
    gate(agent);
  });
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    gate(agent);
  });
  ctx.on('agent/pre-step', ({ agent }, next) => {
    gate(agent);
    return next();
  });
  ctx.on('agent/disposed', ({ agent }) => {
    lift(agent.session.id);
  });

  return () => {
    for (const sessionId of [...held.keys()]) lift(sessionId);
  };
}

/** Validate one name list and return it as a plain array. */
function readNames(config, field) {
  const value = config?.[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`tool-gate: "${field}" must be a non-empty array of tool names`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`tool-gate: "${field}" entries must be non-empty strings, got ${JSON.stringify(entry)}`);
    }
  }
  return [...value];
}
