/**
 * dsh-jaz-invoke — a JAZ-style `invoke` language primitive for the DeepSeek
 * Harness, after arXiv:2609.26891 "Harness as a Language".
 *
 * Two defining properties reproduced:
 *  1. The LLM writes arbitrary executable code (a REPL cell) that may call
 *     `invoke` — a primitive whose function body is provided at call time by
 *     an LLM subagent. Subagents can call this tool again, so recursive
 *     delegation is the default.
 *  2. Everything visible is a variable: `__inputs__`, `__history__`,
 *     `__scope__`, plus user variables that persist across cells of a named
 *     session ("memory as state", no external memory bank).
 *
 * Built on two harness seams: ctx.ptcRuntime (sandboxed code execution with
 * JSON host bindings) and ctx.subagents (one-shot LLM child agents).
 * No external imports: the bundle resolves no packages beyond itself.
 */

export const inject = ['ptcRuntime', 'subagents', 'tools'];

const TOOL_NAME = 'jaz';

const DEFAULTS = {
  /** Subagent provider used for every invoke child. */
  provider: 'spawn',
  /** Absolute delegation-depth cap applied to every invoke child (RecursionLimit). */
  maxDepth: 4,
  /** Total invoke calls per session/run (BudgetPool, counted not dollars). */
  maxInvokes: 32,
  /** Char cap for the rendered named-inputs JSON inside one invoke prompt. */
  maxInvokeInputChars: 24000,
  /** Char cap per __history__ entry payload (inputs/output each). */
  maxHistoryEntryChars: 8000,
  /** Elapsed budget for one cell's sandboxed run, including binding waits. */
  runTimeoutMs: 15 * 60 * 1000,
  /** Optional model override for every invoke child. */
  model: undefined,
};

const DESCRIPTION = `Run one cell in a JAZ-style persistent code REPL (arXiv:2609.26891 "Harness as a Language"). The cell is plain JavaScript (not TypeScript) executed as an async function body: top-level \`await\` and \`return\` are available; the returned JSON value becomes this tool's \`result\`.

The language primitive \`invoke(inputs, opts?)\` is available as a global. Its implementation is provided AT CALL TIME by an LLM subagent: the subagent sees your named inputs rendered as JSON, and its final answer becomes the return value (text, or a structured value when \`opts.schema\` is given). Inputs are uniform — pass task/spec, data, and state as named fields, e.g. \`const summary = await invoke({ task: 'summarize these facts', facts })\`. Options: \`schema\` (object-rooted JSON Schema for a structured return), \`provider\`/\`model\` (model route override), \`scope\` (extra named inputs for this call only). Invoke subagents may call this tool again, so recursive delegation is the default; a delegation-depth cap applies.

Everything visible is a variable: \`__inputs__\` (this call's \`inputs\` argument), \`__history__\` (array of every invoke record so far: seq, inputs, output, ms, childId — filter it, slice it, pass it into later invokes), and \`__scope__\` (mutable object whose snapshot is merged into every subsequent invoke's inputs — dynamic scoping).

Persistence: pass \`session\` to make cells share one REPL. Variables assigned WITHOUT a declaration (\`facts = [...]\`) or via \`globalThis.x = ...\` persist across cells of the same session; \`let\`/\`const\`/\`var\` are cell-local. \`__history__\`, \`__scope__\`, and the invoke budget also persist per session. Use \`reset: true\` to restart a session. Only LOSSLESS JSON DATA persists: a module namespace, class instance, Map/Set, Date, or function is skipped and listed in the result (never silently hollowed by a JSON round trip), and a cell whose return value is not JSON data fails with the offending path.

Scope of the sandbox: the cell runs in a confined Node process, so it is not a substitute for the dedicated file tools — use \`read\`/\`glob\`/\`grep\`/\`bash\` for repository or file inspection, and reach for \`jaz\` when you want generated code with LLM-implemented \`invoke\` calls.

Constraints: every invoke spawns an LLM subagent (slow, costs tokens) and a total-invoke budget applies per session; an over-budget or over-depth call raises \`JazInvokeError\`, which you may catch to degrade gracefully. Keep return values and persisted variables JSON-serializable. Do NOT use this tool for deterministic fan-out over many homogeneous items — use the workflow tool for that. Use jaz when the work needs LLM-decided recursive delegation, long-horizon memory carried as plain variables, or self-improving loops.`;

export function apply(ctx, config) {
  const cfg = readConfig(config);
  const logger = typeof ctx.logger === 'function' ? ctx.logger('jaz-invoke') : console;
  /** @type {Map<string, {env: object, history: any[], scope: object, invokes: number}>} */
  const stores = new Map();

  const freshStore = () => ({ env: {}, history: [], scope: {}, invokes: 0 });

  const dispose = ctx.tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['program'],
      properties: {
        program: {
          type: 'string',
          description: 'The REPL cell: plain JavaScript run as an async function body. Top-level await/return allowed; the JSON return value becomes the tool result. `invoke`, `__inputs__`, `__history__`, `__scope__` are globals.',
        },
        inputs: {
          type: 'object',
          additionalProperties: true,
          description: 'Named inputs of this top-level call, exposed to the cell as the `__inputs__` variable (the prompt is a variable too).',
        },
        session: {
          type: 'string',
          description: 'Named REPL session. Cells sharing a name share persisted globals, __history__, __scope__, and the invoke budget. Omit for a stateless one-shot run.',
        },
        reset: {
          type: 'boolean',
          description: 'Clear the named session (variables, history, scope, budget) before running this cell.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['ok', 'error'] },
          result: {},
          logs: { type: 'array', items: { type: 'string' } },
          trace: { type: 'array', items: { type: 'object', additionalProperties: true } },
          invokesThisRun: { type: 'integer' },
          skippedVars: { type: 'array', items: { type: 'string' } },
          session: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderResult(args, value) }],
    },
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('jaz requires a calling agent (exec.agent was undefined)');
      const cell = typeof args.program === 'string' ? args.program : '';
      if (!cell.trim()) throw new Error('jaz: program must be a non-empty string');

      const sessionName = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : null;
      const ownerId = parent.session && parent.session.id ? String(parent.session.id) : 'agent';
      const key = sessionName ? `${ownerId}:${sessionName}` : null;
      let store = key ? stores.get(key) : null;
      if (key && (!store || args.reset === true)) {
        store = freshStore();
        stores.set(key, store);
      }
      if (!store) store = freshStore(); // ephemeral one-shot

      /** This run's invoke trace (host-side, survives cell failures). */
      const trace = [];
      /**
       * Host-side journal of this cell's invoke calls with full inputs/output.
       * On cell failure the guest's __history__ is lost with the process, so
       * the journal is merged into the persisted history instead: spent calls
       * must not vanish from memory.
       */
      const journal = [];

      const hostInvoke = async (raw) => {
        const req = readInvokeRequest(raw);
        if (store.invokes >= cfg.maxInvokes) {
          throw new Error(`jaz invoke budget exhausted: maxInvokes=${cfg.maxInvokes} reached for ${sessionName ? `session "${sessionName}"` : 'this run'} — catch JazInvokeError and finish with what you have`);
        }
        store.invokes += 1;
        const seq = store.invokes;
        const prompt = renderInvokePrompt(req.inputs, req.schema, cfg);
        const started = Date.now();
        let run;
        try {
          run = await ctx.subagents.start(cfg.provider, {
            label: `jaz invoke #${seq}`,
            prompt: [{ type: 'text', text: prompt }],
            parent,
            signal: exec.signal,
            maxDepth: cfg.maxDepth,
            ...(req.schema ? { outputSchema: req.schema } : {}),
            ...(req.provider || req.model || cfg.model
              ? { agentOptions: {
                  ...(req.provider ? { provider: req.provider } : {}),
                  ...(req.model ?? cfg.model ? { model: req.model ?? cfg.model } : {}),
                } }
              : {}),
          });
        } catch (error) {
          trace.push({ seq, ms: Date.now() - started, stopReason: 'start-failed', childId: null, inputChars: prompt.length, outputKind: null });
          journal.push({ seq, ok: false, ms: Date.now() - started, inputs: capForHistory(req.inputs, cfg), error: `child start failed: ${errorMessage(error)}` });
          throw new Error(`jaz invoke #${seq} could not start a child agent: ${errorMessage(error)}`);
        }
        try {
          const settled = await raceSignal(run.result, exec.signal);
          const output = settled.structured !== undefined
            ? { kind: 'structured', value: settled.structured }
            : { kind: 'text', text: blocksText(settled.output) };
          trace.push({ seq, ms: Date.now() - started, stopReason: settled.stopReason, childId: String(run.id), inputChars: prompt.length, outputKind: output.kind });
          journal.push({ seq, ok: true, ms: Date.now() - started, stopReason: settled.stopReason, childId: String(run.id), inputs: capForHistory(req.inputs, cfg), output: capForHistory(output, cfg) });
          return { ok: true, output, stopReason: settled.stopReason, childId: String(run.id) };
        } finally {
          try { await run.dispose(); } catch (error) { logger.warn?.(`jaz-invoke: child dispose failed: ${errorMessage(error)}`); }
        }
      };

      const source = buildProgram({
        cell,
        env: store.env,
        history: store.history,
        scope: store.scope,
        inputs: isPlainRecord(args.inputs) ? args.inputs : {},
        historyEntryCap: cfg.maxHistoryEntryChars,
      });

      const bindings = [{
        global: 'jaz',
        errorClass: { name: 'JazInvokeError', memberNameProperty: 'member' },
        functions: { invoke: hostInvoke },
      }];

      let spec;
      try {
        spec = ctx.ptcRuntime.resolve({ program: source, bindings, timeoutMs: cfg.runTimeoutMs, signal: exec.signal });
      } catch (error) {
        throw new Error(`jaz: PTC runtime rejected the run: ${errorMessage(error)}`);
      }
      const run = await ctx.ptcRuntime.run(spec);

      if (run.error) {
        // A failed cell never touches persisted env/scope: no half-state. But
        // its invoke calls DID happen (tokens spent) — merge the host journal
        // into the persisted history so memory stays lossless.
        if (journal.length > 0) {
          store.history = store.history.concat(journal.map((entry, i) => ({ ...entry, seq: store.history.length + i + 1, cellFailed: true })));
        }
        return {
          kind: 'error',
          result: null,
          logs: Array.isArray(run.logs) ? run.logs : [],
          trace,
          invokesThisRun: trace.length,
          skippedVars: [],
          ...(sessionName ? { session: sessionInfo(sessionName, store) } : {}),
          error: `${run.error.kind}: ${run.error.message}`,
        };
      }

      const value = isPlainRecord(run.value) ? run.value : {};
      store.env = isPlainRecord(value.env) ? value.env : {};
      if (Array.isArray(value.history)) store.history = value.history;
      if (isPlainRecord(value.scope)) store.scope = value.scope;
      const skipped = Array.isArray(value.skippedVars) ? value.skippedVars : [];

      if (typeof value.resultIssue === 'string' && value.resultIssue) {
        // The cell ran; only its return value cannot cross the JSON boundary.
        // State is persisted (the work happened) and the failure is reported
        // with the offending path instead of PTC's bare `invalid-output`.
        return {
          kind: 'error',
          result: null,
          logs: Array.isArray(run.logs) ? run.logs : [],
          trace,
          invokesThisRun: trace.length,
          skippedVars: skipped,
          ...(sessionName ? { session: value.session ?? sessionInfo(sessionName, store) } : {}),
          error: `the cell's return value is not lossless JSON — ${value.resultIssue}. Return plain JSON data only (strings, numbers, booleans, null, arrays, plain objects); convert class instances, Map/Set, Date, functions, and undefined first.`,
        };
      }

      return {
        kind: 'ok',
        result: value.result === undefined ? null : value.result,
        logs: Array.isArray(run.logs) ? run.logs : [],
        trace,
        invokesThisRun: trace.length,
        skippedVars: skipped,
        ...(sessionName ? { session: sessionInfo(sessionName, store) } : {}),
      };
    },
  });

  logger.info?.(`dsh-jaz-invoke: registered tool "${TOOL_NAME}" (provider=${cfg.provider}, maxDepth=${cfg.maxDepth}, maxInvokes=${cfg.maxInvokes})`);
  return dispose;
}

/* ------------------------------ config ------------------------------ */

function readConfig(config) {
  const raw = isPlainRecord(config) ? config : {};
  const num = (v, d, min) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : d);
  return {
    provider: typeof raw.provider === 'string' && raw.provider ? raw.provider : DEFAULTS.provider,
    maxDepth: num(raw.maxDepth, DEFAULTS.maxDepth, 0),
    maxInvokes: num(raw.maxInvokes, DEFAULTS.maxInvokes, 1),
    maxInvokeInputChars: num(raw.maxInvokeInputChars, DEFAULTS.maxInvokeInputChars, 1000),
    maxHistoryEntryChars: num(raw.maxHistoryEntryChars, DEFAULTS.maxHistoryEntryChars, 500),
    runTimeoutMs: num(raw.runTimeoutMs, DEFAULTS.runTimeoutMs, 10000),
    model: typeof raw.model === 'string' && raw.model ? raw.model : undefined,
  };
}

/* --------------------------- guest program --------------------------- */

function buildProgram({ cell, env, history, scope, inputs, historyEntryCap }) {
  const J = (v) => JSON.stringify(v === undefined ? null : v);
  return `// ---- jaz prelude (generated by dsh-jaz-invoke; not part of your cell) ----
const __jazEnv = ${J(env)};
const __jazBaseline = new Set(Reflect.ownKeys(globalThis));
for (const k of Object.keys(__jazEnv)) {
  try { globalThis[k] = __jazEnv[k]; }
  catch { Object.defineProperty(globalThis, k, { value: __jazEnv[k], writable: true, enumerable: true, configurable: true }); }
}
const __inputs__ = ${J(inputs)};
const __history__ = ${J(history)};
const __scope__ = ${J(scope)};
globalThis.__inputs__ = __inputs__;
globalThis.__history__ = __history__;
globalThis.__scope__ = __scope__;
const __jazCap = (value) => {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return null;
    // DETACH: history entries are snapshots, never live references — a live
    // reference to __history__ would make the completion value cyclic.
    if (s.length <= ${historyEntryCap}) return JSON.parse(s);
    return { __jazTruncated: true, chars: s.length, preview: s.slice(0, ${historyEntryCap}) };
  } catch { return { __jazTruncated: true, note: 'value is not JSON-serializable' }; }
};
async function invoke(inputs, opts) {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) throw new Error('invoke(inputs, opts?): inputs must be an object of named inputs');
  const callOpts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const merged = Object.assign({}, __scope__, (callOpts.scope && typeof callOpts.scope === 'object' && !Array.isArray(callOpts.scope)) ? callOpts.scope : {}, inputs);
  const started = Date.now();
  let res;
  try {
    res = await jaz.invoke({ inputs: merged, opts: { schema: callOpts.schema ?? null, provider: callOpts.provider ?? null, model: callOpts.model ?? null } });
  } catch (error) {
    __history__.push({ seq: __history__.length + 1, ok: false, ms: Date.now() - started, inputs: __jazCap(merged), error: String((error && error.message) || error) });
    throw error;
  }
  __history__.push({ seq: __history__.length + 1, ok: res.ok === true, stopReason: res.stopReason ?? null, ms: Date.now() - started, childId: res.childId ?? null, inputs: __jazCap(merged), output: __jazCap(res.output === undefined ? null : res.output) });
  if (res.ok !== true) { const e = new Error(String(res.error || 'invoke failed')); e.name = 'JazInvokeError'; throw e; }
  const out = res.output;
  if (out && out.kind === 'structured') return out.value;
  if (out && out.kind === 'text') return out.text;
  return null;
}
globalThis.invoke = invoke;
// ---- your cell ----
const __jazCell = new (Object.getPrototypeOf(async function () {}).constructor)(${JSON.stringify(cell)});
const __jazValue = await __jazCell();
// ---- jaz postlude: validate the return value, then harvest persisted globals ----
// A value may cross the PTC boundary (as the result OR as a persisted variable)
// only when it is LOSSLESS JSON DATA. Anything else is skipped WITH A REASON:
// a JSON round trip would either make the whole completion value invalid (the
// run fails as "invalid-output") or silently hollow the value into a plain
// object whose methods are gone — both are worse than a named skip.
const __jazWhy = (value, path) => {
  const seen = new Set();
  const walk = (v, p) => {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'boolean' || t === 'string') return null;
    if (t === 'number') return (Number.isFinite(v) && !Object.is(v, -0)) ? null : p + ': non-finite or negative-zero number';
    if (t !== 'object') return p + ': ' + t + ' is not JSON data';
    if (seen.has(v)) return p + ': circular reference';
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const own = Reflect.ownKeys(v).length;
        if (own !== v.length + 1) return p + ': sparse or decorated array is not JSON data';
        for (const key of Object.keys(v)) {
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index >= v.length) return p + '.' + key + ': non-index array property is not JSON data';
        }
        for (let i = 0; i < v.length; i += 1) { const r = walk(v[i], p + '[' + i + ']'); if (r) return r; }
      } else {
        const proto = Object.getPrototypeOf(v);
        if (!(proto === null || Object.getPrototypeOf(proto) === null)) return p + ': only plain objects and arrays are JSON data (this is a class instance or module namespace)';
        for (const key of Object.keys(v)) { const r = walk(v[key], p + '.' + key); if (r) return r; }
      }
      if (Object.getOwnPropertySymbols(v).length > 0) return p + ': symbol-keyed properties are not JSON data';
      return null;
    } finally { seen.delete(v); }
  };
  return walk(value, path || 'value');
};
const __jazResultReason = __jazWhy(__jazValue, 'return value');
const __env = {};
const __skipped = [];
for (const key of Reflect.ownKeys(globalThis)) {
  if (typeof key !== 'string') continue;
  if (__jazBaseline.has(key)) continue;
  if (key === 'invoke' || key === '__inputs__' || key === '__history__' || key === '__scope__') continue;
  if (key.startsWith('__jaz')) continue;
  const reason = __jazWhy(globalThis[key], key);
  if (reason) { __skipped.push(reason); continue; }
  __env[key] = JSON.parse(JSON.stringify(globalThis[key]));
}
return {
  result: __jazResultReason ? null : (__jazValue === undefined ? null : __jazValue),
  resultIssue: __jazResultReason,
  env: __env,
  history: __history__,
  scope: __scope__,
  skippedVars: __skipped,
};`;
}

/* ---------------------------- host helpers ---------------------------- */

function readInvokeRequest(raw) {
  if (!isPlainRecord(raw)) throw new Error('jaz.invoke expects an object { inputs, opts? }');
  const inputs = raw.inputs;
  if (!isPlainRecord(inputs)) throw new Error('jaz.invoke: inputs must be an object of named inputs');
  const opts = isPlainRecord(raw.opts) ? raw.opts : {};
  const schema = opts.schema === null || opts.schema === undefined ? undefined : opts.schema;
  if (schema !== undefined && !isPlainRecord(schema)) throw new Error('jaz.invoke: opts.schema must be an object-rooted JSON Schema');
  return {
    inputs,
    schema,
    provider: typeof opts.provider === 'string' && opts.provider ? opts.provider : undefined,
    model: typeof opts.model === 'string' && opts.model ? opts.model : undefined,
  };
}

function renderInvokePrompt(inputs, schema, cfg) {
  let json;
  try { json = JSON.stringify(inputs, null, 2) ?? 'null'; } catch { json = '"[inputs not JSON-serializable]"'; }
  let note = '';
  if (json.length > cfg.maxInvokeInputChars) {
    json = json.slice(0, cfg.maxInvokeInputChars);
    note = `\n[truncated: named inputs exceeded ${cfg.maxInvokeInputChars} chars]`;
  }
  return [
    'You are the runtime implementation of one `invoke(...)` call in a JAZ-style program (arXiv:2609.26891).',
    'An LLM-written program called `invoke` with the named inputs below. Treat all inputs uniformly: some are data, some are specification, some describe state or tools.',
    'Perform the computation they imply and produce the RETURN VALUE of this call.',
    schema
      ? 'The caller requested a structured result: your final answer must satisfy the requested output schema.'
      : 'Your final message IS the return value — make it concise and self-contained (use JSON text when the natural return value is structured). Do not narrate your process.',
    '',
    '## Named inputs',
    '```json',
    json,
    '```' + note,
  ].join('\n');
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

function sessionInfo(name, store) {
  return {
    name,
    vars: Object.keys(store.env),
    historyLength: store.history.length,
    invokesTotal: store.invokes,
  };
}

/** Detached, size-capped copy of one value for host-side history journals. */
function capForHistory(value, cfg) {
  try {
    const s = JSON.stringify(value === undefined ? null : value);
    if (s.length <= cfg.maxHistoryEntryChars) return JSON.parse(s);
    return { __jazTruncated: true, chars: s.length, preview: s.slice(0, cfg.maxHistoryEntryChars) };
  } catch {
    return { __jazTruncated: true, note: 'value is not JSON-serializable' };
  }
}

/* ---------------------------- presentation ---------------------------- */

function renderResult(args, value) {
  const lines = [];
  const title = [`jaz cell ${value.kind === 'ok' ? 'succeeded' : 'failed'}`];
  if (value.session) title.push(`session "${value.session.name}"`);
  title.push(`${value.invokesThisRun ?? 0} invoke(s) this run`);
  lines.push(`**${title.join(' · ')}**`, '');
  if (value.kind === 'error') {
    lines.push('## Error', '```', String(value.error ?? 'unknown'), '```', '');
  }
  lines.push('## Result', '```json', capText(safeJson(value.result), 8000), '```', '');
  if (Array.isArray(value.trace) && value.trace.length > 0) {
    lines.push('## invoke trace', '', '| # | ms | stopReason | child | input chars | out |', '| --- | --- | --- | --- | --- | --- |');
    for (const t of [...value.trace].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
      lines.push(`| ${t.seq} | ${t.ms} | ${t.stopReason ?? ''} | ${shortId(t.childId)} | ${t.inputChars ?? ''} | ${t.outputKind ?? ''} |`);
    }
    lines.push('');
  }
  if (value.session) {
    lines.push(`## REPL session "${value.session.name}"`, `vars: ${value.session.vars.length ? value.session.vars.join(', ') : '(none)'} · history: ${value.session.historyLength} entries · invokes total: ${value.session.invokesTotal}`, '');
  }
  if (Array.isArray(value.skippedVars) && value.skippedVars.length > 0) {
    lines.push('## not persisted (not lossless JSON data)', ...value.skippedVars.map((entry) => `- ${entry}`), '');
    lines.push('These variables will NOT exist in the next cell of this session. Re-create them inside the cell that needs them (e.g. `const fs = await import(\'node:fs\')` in that same cell); only plain JSON data survives across cells.', '');
  }
  if (Array.isArray(value.logs) && value.logs.length > 0) {
    const tail = value.logs.slice(-5).join('\n');
    lines.push('## logs (last 5)', '```', capText(tail, 2000), '```');
  }
  return lines.join('\n');
}

/* ------------------------------ utilities ------------------------------ */

function isPlainRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorMessage(error) {
  return String((error && error.message) || error);
}

function safeJson(v) {
  try { return JSON.stringify(v, null, 2) ?? 'null'; } catch { return '"[not JSON-serializable]"'; }
}

function capText(s, cap) {
  return s.length <= cap ? s : `${s.slice(0, cap)}\n[truncated: ${s.length} chars total]`;
}

function shortId(id) {
  if (!id) return '';
  const s = String(id);
  return s.length <= 12 ? s : `${s.slice(0, 8)}…`;
}
