/**
 * dsh-jaz-mode — JAZ mode for the DeepSeek Harness, after arXiv:2609.26891
 * "Harness as a Language".
 *
 * A "mode" here is not a new tool: it collapses an agent's surface to the
 * invoke REPL, exactly like the paper's minimal harness. Two ways in:
 *
 *  1. `jaz_agent` — run one JAZ-mode child agent: its tool filter keeps only
 *     `jaz`, so it can do nothing except write cells that call `invoke`.
 *  2. `jaz_mode`  — turn the CALLING agent into JAZ mode at runtime, scoped to
 *     that agent (`agent.ctx`), reversible with `jaz_mode exit`. Survivors:
 *     `jaz` and `jaz_mode` itself, plus any extra tools the caller allows.
 *
 * Config `mode: 'jaz'` additionally makes JAZ mode the deployment default
 * (process-wide restriction + a global JAZ protocol prompt section).
 *
 * Depends on `@local/dsh-jaz-invoke` for the `jaz` tool. No external imports.
 */

export const inject = ['tools', 'subagents', 'systemPrompt'];

const JAZ_TOOL = 'jaz';
const AGENT_TOOL = 'jaz_agent';
const MODE_TOOL = 'jaz_mode';

const DEFAULTS = {
  /** Subagent provider used by jaz_agent. */
  provider: 'spawn',
  /** Absolute delegation-depth cap for a JAZ child. */
  maxDepth: 2,
  /** Deployment default: 'native' (leave the surface alone) or 'jaz'. */
  mode: 'native',
  /** Extra tools that stay visible in JAZ mode (besides jaz and jaz_mode). */
  allowTools: [],
  /** Model override for JAZ children. */
  model: undefined,
};

/** Shared protocol text: registered as a prompt section (JAZ mode) or a child persona. */
const JAZ_PROTOCOL = `# JAZ MODE — you work by writing cells (arXiv:2609.26891)

Your environment is a code REPL, not a list of tools. Everything you can do goes through the \`jaz\` tool, and everything you can see is a variable.

## The primitive
\`invoke(inputs, opts?)\` is a function whose implementation is provided AT CALL TIME by another LLM. It treats every input uniformly — data, specification, state, or a description of a tool:
\`\`\`js
const out = await invoke({ task: 'summarize these notes', notes });              // -> text
const obj = await invoke({ text }, { schema: { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'] } }); // -> validated object
\`\`\`
Sub-invokes may call \`invoke\` again, so recursive delegation is the default; a delegation-depth cap applies.

## The variables (this is the point)
- \`__inputs__\` — the named inputs of the current \`jaz\` call. Put the user's request and any guidance in \`inputs\` on the first cell, then reuse those names.
- \`__history__\` — every invoke of this session: \`{seq, inputs, output, ms, childId}\`. Filter it, slice it, pass it into later invokes.
- \`__scope__\` — mutable object merged into every later invoke (dynamic scoping).
- State persists across cells by BARE ASSIGNMENT (\`facts = [...]\`) or \`globalThis.x = ...\`; \`let\`/\`const\`/\`var\` live only inside one cell.

## Protocol
1. One meaningful step per cell. Pass \`session\` on every call so state persists; never re-derive what a variable already holds.
2. Delegate with \`invoke\` instead of reasoning harder: sub-problems, extraction, verification, drafting.
3. To recall earlier details, search \`prev_history\` (an earlier agent's history handed to you), NOT \`__history__\` (already fully visible to you). Use targeted search terms and show surrounding context.
4. When your history grows large (roughly more than 20 entries or 40k characters), stop working in this session and delegate the rest:
   \`\`\`js
   return invoke({ instructions, guidance,
     prev_history: (typeof prev_history === 'undefined' ? [] : prev_history).concat(__history__),
     prev_progress_summary, next_steps });
   \`\`\`
   Later cells must carry \`prev_history\` forward so nothing is lost.
5. A per-session invoke budget applies. An over-budget call raises \`JazInvokeError\`: catch it and finish with what you have instead of failing the run.
6. Finish by returning a JSON value from your final cell and reporting that value as your answer.

## Style
Write compact code. Do not narrate; a cell either returns a value or it does not.`;

const AGENT_TOOL_DESCRIPTION = `Run ONE JAZ-mode child agent (arXiv:2609.26891): a subagent whose only tool is \`jaz\`, so it must do all work by writing cells that call \`invoke\`. Use it for long-horizon or memory-heavy jobs you want done in a minimal, prompt-only harness — the child keeps its state in REPL variables and remembers via \`__history__\`, without any file system or memory system.

The child returns its final answer as text. Give it a \`session\` name when you may want to inspect or continue similar work later (sessions live in the jaz plugin's in-memory store, keyed per child).`;

const MODE_TOOL_DESCRIPTION = `Enter, leave, or inspect JAZ mode for THIS agent (arXiv:2609.26891).

On \`enter\`, every other tool is hidden from you and a JAZ protocol prompt section is installed, so from your next step on you work only by writing \`jaz\` cells that call \`invoke\`. \`jaz\` and \`jaz_mode\` stay visible so you can work and later leave. The change is scoped to this agent only and is reversible with \`action: "exit"\`.

Extra tools can be kept with \`allow: ["bash", ...]\` (only names that exist are accepted).`;

export function apply(ctx, config) {
  const cfg = readConfig(config);
  const logger = typeof ctx.logger === 'function' ? ctx.logger('jaz-mode') : console;
  /** agentId -> { disposers: Array<() => void>, allow: string[], enteredAt: number } */
  const active = new Map();
  const disposers = [];

  const jazAvailable = () => typeof ctx.tools.get(JAZ_TOOL) === 'function' || Boolean(ctx.tools.get(JAZ_TOOL));

  const resolveAllow = (extra, agent) => {
    const wanted = [JAZ_TOOL, MODE_TOOL, ...cfg.allowTools, ...(Array.isArray(extra) ? extra : [])];
    const out = [];
    const unknown = [];
    for (const name of wanted) {
      if (typeof name !== 'string' || !name || out.includes(name)) continue;
      if (name === JAZ_TOOL || name === MODE_TOOL) { out.push(name); continue; }
      // The agent object IS the viewing scope key for ctx.tools.get/schemas;
      // shipped tools live on the agent plane and are invisible to the global view.
      const seen = agent ? ctx.tools.get(name, agent) : ctx.tools.get(name);
      if (seen) out.push(name);
      else unknown.push(name);
    }
    return { allow: out, unknown };
  };

  const enterMode = (agent, extra) => {
    const agentId = String(agent.session?.id ?? agent.id ?? 'agent');
    const existing = active.get(agentId);
    if (existing) return { ...statusOf(agent, agentId), alreadyActive: true };
    const { allow, unknown } = resolveAllow(extra, agent);
    const scoped = agent.ctx;
    const entries = [];
    try {
      entries.push(scoped.tools.restrict({ allow }));
      entries.push(scoped.systemPrompt.section({ name: 'jaz-mode', order: 850, text: JAZ_PROTOCOL, interpolate: false }));
    } catch (error) {
      for (const dispose of entries.reverse()) { try { dispose(); } catch { /* ignore */ } }
      throw new Error(`jaz_mode: could not enter JAZ mode: ${errorMessage(error)}`);
    }
    active.set(agentId, { disposers: entries, allow, enteredAt: Date.now() });
    logger.info?.(`jaz-mode: agent ${agentId} entered JAZ mode (allow: ${allow.join(', ')})`);
    return { ...statusOf(agent, agentId), unknown };
  };

  const exitMode = (agent) => {
    const agentId = String(agent.session?.id ?? agent.id ?? 'agent');
    const entry = active.get(agentId);
    if (!entry) return { active: false, agentId, allow: [], wasActive: false };
    active.delete(agentId);
    for (const dispose of entry.disposers.reverse()) { try { dispose(); } catch { /* ignore */ } }
    logger.info?.(`jaz-mode: agent ${agentId} left JAZ mode`);
    return { active: false, agentId, allow: entry.allow, wasActive: true };
  };

  const statusOf = (agent, agentIdArg) => {
    const agentId = agentIdArg ?? String(agent.session?.id ?? agent.id ?? 'agent');
    const entry = active.get(agentId);
    return { active: Boolean(entry), agentId, allow: entry?.allow ?? [] };
  };

  /* ------------------------------- jaz_mode ------------------------------- */
  disposers.push(ctx.tools.register({
    name: MODE_TOOL,
    description: MODE_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['enter', 'exit', 'status'], description: 'enter hides every other tool for this agent; exit restores the previous surface; status reports the current state.' },
        allow: { type: 'array', items: { type: 'string' }, description: 'Extra tool names that stay visible under JAZ mode (e.g. ["bash"]). Unknown names are reported, not fatal.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          kind: { type: 'string', enum: ['ok', 'error'] },
          action: { type: 'string' },
          active: { type: 'boolean' },
          agentId: { type: 'string' },
          allow: { type: 'array', items: { type: 'string' } },
          visibleTools: { type: 'array', items: { type: 'string' } },
          unknown: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderMode(value) }],
    },
    execute(args, exec) {
      const agent = exec.agent;
      if (!agent) throw new Error('jaz_mode requires a calling agent (exec.agent was undefined)');
      const action = args.action;
      if (action === 'enter') {
        if (!jazAvailable()) throw new Error(`jaz_mode: the "${JAZ_TOOL}" tool is not registered — install @local/dsh-jaz-invoke first`);
        const result = enterMode(agent, args.allow);
        return { kind: 'ok', action, ...result, visibleTools: visibleTools(agent) };
      }
      if (action === 'exit') {
        const result = exitMode(agent);
        return { kind: 'ok', action, ...result, visibleTools: visibleTools(agent) };
      }
      const status = statusOf(agent);
      return { kind: 'ok', action: 'status', ...status, allow: status.allow, visibleTools: visibleTools(agent) };
    },
  }));

  /* ------------------------------- jaz_agent ------------------------------ */
  disposers.push(ctx.tools.register({
    name: AGENT_TOOL,
    description: AGENT_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        task: { type: 'string', description: 'The complete, self-contained job for the JAZ-mode child. It sees nothing of this conversation.' },
        session: { type: 'string', description: 'Optional REPL session name handed to the child (defaults to a generated name).' },
        model: { type: 'string', description: 'Optional model override for the child.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          kind: { type: 'string', enum: ['ok', 'error'] },
          output: { type: 'string' },
          childId: { type: 'string' },
          stopReason: { type: 'string' },
          session: { type: 'string' },
          diagnostic: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderAgent(args, value) }],
    },
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('jaz_agent requires a calling agent (exec.agent was undefined)');
      if (!jazAvailable()) throw new Error(`jaz_agent: the "${JAZ_TOOL}" tool is not registered — install @local/dsh-jaz-invoke first`);
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) throw new Error('jaz_agent: task must be a non-empty string');

      const provider = ctx.subagents.getProvider(cfg.provider);
      if (!provider) throw new Error(`jaz_agent: subagent provider "${cfg.provider}" is not registered`);
      if (!provider.capabilities.toolFilter) throw new Error(`jaz_agent: provider "${cfg.provider}" does not support toolFilter`);

      const session = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : `jaz-${Date.now().toString(36)}`;
      const model = typeof args.model === 'string' && args.model ? args.model : cfg.model;

      const run = await ctx.subagents.start(cfg.provider, {
        label: `jaz agent: ${task.slice(0, 48)}`,
        prompt: [{ type: 'text', text: childTaskPrompt(task, session) }],
        parent,
        signal: exec.signal,
        maxDepth: cfg.maxDepth,
        toolFilter: { allow: [JAZ_TOOL] },
        ...(provider.capabilities.persona ? { persona: JAZ_PROTOCOL } : {}),
        ...(model ? { agentOptions: { model } } : {}),
      });
      try {
        const settled = await raceSignal(run.result, exec.signal);
        const output = blocksText(settled.output);
        return {
          kind: settled.stopReason === 'completed' ? 'ok' : 'error',
          output,
          childId: String(run.id),
          stopReason: settled.stopReason,
          session,
          ...(settled.diagnostic ? { diagnostic: settled.diagnostic } : {}),
        };
      } finally {
        try { await run.dispose(); } catch (error) { logger.warn?.(`jaz-mode: child dispose failed: ${errorMessage(error)}`); }
      }
    },
  }));

  /* --------------------------- deployment default -------------------------- */
  if (cfg.mode === 'jaz') {
    if (jazAvailable()) {
      const { allow, unknown } = resolveAllow([], undefined);
      if (unknown.length > 0) logger.warn?.(`jaz-mode: ignoring unknown allowTools: ${unknown.join(', ')}`);
      try {
        disposers.push(ctx.tools.restrict({ allow }));
        disposers.push(ctx.systemPrompt.section({ name: 'jaz-mode', order: 850, text: JAZ_PROTOCOL, interpolate: false }));
        logger.info?.(`jaz-mode: deployment default JAZ mode active (allow: ${allow.join(', ')})`);
      } catch (error) {
        logger.warn?.(`jaz-mode: config mode="jaz" could not be applied: ${errorMessage(error)}`);
      }
    } else {
      logger.warn?.(`jaz-mode: config mode="jaz" ignored because the "${JAZ_TOOL}" tool is not registered`);
    }
  }

  logger.info?.(`dsh-jaz-mode: ready (mode=${cfg.mode}, provider=${cfg.provider})`);

  return () => {
    for (const [agentId, entry] of active) {
      for (const dispose of entry.disposers.reverse()) { try { dispose(); } catch { /* ignore */ } }
      active.delete(agentId);
    }
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* ignore */ } }
  };

  /** Names currently visible to `agent`, best-effort (informational only). */
  function visibleTools(agent) {
    try {
      const schemas = ctx.tools.schemas(agent);
      return Array.isArray(schemas) ? schemas.map((s) => s?.name).filter((n) => typeof n === 'string') : [];
    } catch {
      return [];
    }
  }
}

/* --------------------------------- helpers -------------------------------- */

function childTaskPrompt(task, session) {
  return [
    'Your task (this is the whole job; anything else in this message is only guidance):',
    '',
    task,
    '',
    'Work it as a JAZ agent:',
    `- You have exactly one tool: \`jaz\`. Pass \`program\` (plain JavaScript, async body, top-level await/return allowed) and \`session: "${session}"\` on EVERY call so your REPL variables persist between cells.`,
    '- Inside a cell, call `invoke({ ... })` — another LLM implements that function at call time and its answer is the return value.',
    '- Store the task and any guidance as variables first (bare assignment, e.g. `instructions = ...`), then do one step per cell.',
    '- When you are done, make your final cell return the answer as JSON, then repeat that answer as your final message.',
  ].join('\n');
}

function readConfig(config) {
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const num = (v, d, min) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : d);
  return {
    provider: typeof raw.provider === 'string' && raw.provider ? raw.provider : DEFAULTS.provider,
    maxDepth: num(raw.maxDepth, DEFAULTS.maxDepth, 1),
    mode: raw.mode === 'jaz' ? 'jaz' : 'native',
    allowTools: Array.isArray(raw.allowTools) ? raw.allowTools.filter((n) => typeof n === 'string' && n) : [],
    model: typeof raw.model === 'string' && raw.model ? raw.model : undefined,
  };
}

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function errorMessage(error) {
  return String((error && error.message) || error);
}

function renderMode(value) {
  const lines = [`**jaz_mode · ${value.action}** — ${value.active ? 'JAZ mode is ON' : 'JAZ mode is OFF'} (agent ${shortId(value.agentId)})`];
  if (value.allow?.length) lines.push(`- allowed tools: ${value.allow.join(', ')}`);
  if (value.unknown?.length) lines.push(`- ignored unknown names: ${value.unknown.join(', ')}`);
  if (value.visibleTools?.length) lines.push(`- visible now: ${value.visibleTools.join(', ')}`);
  if (value.action === 'enter') lines.push('', 'From your next step, work by writing `jaz` cells that call `invoke`. Call `jaz_mode` with `action: "exit"` to restore your tools.');
  if (value.action === 'exit') lines.push('', 'Your previous tool surface is restored.');
  if (value.error) lines.push('', `error: ${value.error}`);
  return lines.join('\n');
}

function renderAgent(args, value) {
  const head = `**jaz_agent ${value.kind === 'ok' ? 'completed' : 'failed'}** · child ${shortId(value.childId)} · ${value.stopReason ?? ''} · session "${value.session ?? ''}"`;
  const body = value.output ? `\n\n${value.output}` : '';
  const diag = value.diagnostic ? `\n\ndiagnostic: ${value.diagnostic}` : '';
  return head + body + diag;
}

function shortId(id) {
  if (!id) return '';
  const s = String(id);
  return s.length <= 12 ? s : `${s.slice(0, 8)}…`;
}
