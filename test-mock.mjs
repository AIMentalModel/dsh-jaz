// Mock end-to-end test of the jaz tool definition without a live Harness.
// Simulates the PTC seam (runs the generated program with a mocked `jaz`
// binding global) and the subagent seam (canned answers), then exercises
// two cells over one named session to verify REPL persistence.
import { apply } from './index.js';
import vm from 'node:vm';

let toolDef = null;
const mockCtx = {
  logger: () => ({ info() {}, warn() {} }),
  tools: { register(def) { toolDef = def; return () => {}; } },
  subagents: {
    async start(name, req) {
      const id = `child-${Math.random().toString(36).slice(2, 8)}`;
      return {
        id,
        result: Promise.resolve({
          output: [{ type: 'text', text: `fact-from-${name}:${req.label}` }],
          stopReason: 'completed',
        }),
        async dispose() {},
      };
    },
  },
  ptcRuntime: {
    resolve(req) { return { ...req, cwd: '/tmp', timeoutMs: req.timeoutMs ?? 60000 }; },
    async run(spec) {
      // Emulate PTC process isolation: a fresh VM global per run.
      const context = vm.createContext({});
      context.jaz = { invoke: spec.bindings[0].functions.invoke };
      try {
        const script = new vm.Script(`(async () => {\n${spec.program}\n})()`);
        const value = await script.runInContext(context);
        return { value: JSON.parse(JSON.stringify(value)), logs: [] };
      } catch (e) {
        return { logs: [], error: { kind: 'exception', message: String((e && e.message) || e) } };
      }
    },
  },
};

apply(mockCtx, {});
if (!toolDef) throw new Error('tool was not registered');

const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal };

const cell1 = `facts = [];
for (let i = 0; i < 3; i++) facts.push(await invoke({ round: i, instruction: 'make a fact' }));
__scope__.audience = 'tester';
const mid = await invoke({ task: 'interim summary', facts });
summary = mid;
return facts.length;`;

const r1 = await toolDef.execute({ program: cell1, session: 't' }, exec);
console.log('--- cell1 ---');
console.log(JSON.stringify(r1, null, 2));
if (r1.kind !== 'ok' || r1.result !== 3) throw new Error('cell1 failed');
if (r1.trace.length !== 4) throw new Error(`expected 4 invokes, got ${r1.trace.length}`);

const cell2 = `return {
  persistedFacts: typeof facts === 'undefined' ? -1 : facts.length,
  persistedSummary: typeof summary === 'undefined' ? null : summary,
  scopeSeen: __scope__.audience ?? null,
  historyLength: __history__.length,
  localOnly: (() => { let x = 1; return x; })()
};`;

const r2 = await toolDef.execute({ program: cell2, session: 't' }, exec);
console.log('--- cell2 ---');
console.log(JSON.stringify(r2, null, 2));
if (r2.kind !== 'ok') throw new Error('cell2 failed: ' + r2.error);
if (r2.result.persistedFacts !== 3) throw new Error('facts did not persist');
if (!r2.result.persistedSummary) throw new Error('summary did not persist');
if (r2.result.scopeSeen !== 'tester') throw new Error('__scope__ did not persist');
if (r2.result.historyLength !== 4) throw new Error('__history__ did not persist');

// budget guard: maxInvokes default 32 — session t already used 4; run a cell with 40 invokes in a fresh tiny session via reset + config? use ephemeral run:
const cellBudget = `let n = 0;
try { for (let i = 0; i < 40; i++) { await invoke({ i }); n++; } } catch (e) { if (e.name !== 'JazInvokeError' && !String(e.message).includes('budget')) throw e; }
return n;`;
const r3 = await toolDef.execute({ program: cellBudget }, exec);
console.log('--- budget cell ---');
console.log(JSON.stringify({ kind: r3.kind, result: r3.result, traceLen: r3.trace.length }));
if (r3.kind !== 'ok' || r3.result !== 32) throw new Error(`budget guard failed: n=${r3.result}`);

// regression: passing __history__ itself into invoke must not create a cyclic completion value
const cellSelfRef = `const recall = await invoke({ task: 'recall', prev_history: __history__, facts });
recallResult = recall;
return { ok: true, historyLength: __history__.length };`;
const r4 = await toolDef.execute({ program: cellSelfRef, session: 't' }, exec);
console.log('--- self-reference cell ---');
console.log(JSON.stringify({ kind: r4.kind, result: r4.result, session: r4.session, error: r4.error ?? null }));
if (r4.kind !== 'ok') throw new Error('self-reference cell failed: ' + r4.error);
if (r4.result.historyLength !== 5) throw new Error(`expected history 5, got ${r4.result.historyLength}`);

// regression: a failing cell still merges its invoke journal into persisted history
const before = r4.session.historyLength;
const cellFail = `await invoke({ task: 'this call happens before the cell fails' });
throw new Error('cell blows up after spending an invoke');`;
const r5 = await toolDef.execute({ program: cellFail, session: 't' }, exec);
console.log('--- failing cell ---');
console.log(JSON.stringify({ kind: r5.kind, error: r5.error, session: r5.session }));
if (r5.kind !== 'error') throw new Error('expected cell failure');
if (r5.session.historyLength !== before + 1) throw new Error(`failed cell's invoke was not journaled into history: ${r5.session.historyLength} != ${before + 1}`);

console.log('ALL MOCK TESTS PASSED');
