import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/modules/companies/composables/use-valuation-dashboard.ts', import.meta.url), 'utf8');
const listeners = new Map();
const unmount = [];
const document = { visibilityState: 'hidden', addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
const module = { exports: {} };
const require = createRequire(import.meta.url);
const context = {
  module, exports: module.exports, document,
  require: name => name === 'vue' ? {
    onMounted: fn => fn(), onBeforeUnmount: fn => unmount.push(fn),
    ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
  } : require(name),
  setInterval() { throw new Error('Dashboard must not poll'); },
  setTimeout() { throw new Error('Dashboard must not auto-schedule batches'); },
};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const calls = [];
let finish;
const api = (path, method) => {
  calls.push({ path, method });
  return new Promise(resolve => { finish = () => resolve({ schemaVersion: 5, pending: [], rows: [], targets: [], companies: 0 }); });
};
const controller = new AbortController();
const screen = module.exports.useValuationDashboard(api, controller.signal);
assert.equal(calls.length, 0, 'construction must not start work');
document.visibilityState = 'hidden';
await screen.loadScreen(true);
assert.equal(calls.length, 0, 'hidden page cannot compute');
document.visibilityState = 'visible';
listeners.get('visibilitychange')();
const pending = screen.loadScreen(true);
assert.equal(calls.length, 1);
assert.equal(calls[0].method, 'POST');
assert.equal(calls[0].path, '/api/research/valuation-screen/refresh');
await screen.loadScreen(true);
assert.equal(calls.length, 1, 'no duplicate in-flight batch');
document.visibilityState = 'hidden';
finish();
await pending;
await new Promise(resolve => setImmediate(resolve));
assert.equal(calls.length, 1, 'completion while hidden must not schedule another batch');
document.visibilityState = 'visible';
listeners.get('visibilitychange')();
assert.equal(calls.length, 1, 'returning to the tab must not trigger another refresh');
for (const fn of unmount) fn();
assert.equal(listeners.size, 0, 'visibility listener removed on unmount');
controller.abort();
await screen.loadScreen(true);
assert.equal(calls.length, 1, 'unmounted page cannot compute');
console.log('valuation dashboard demand tests: passed (hidden, bounded, single-flight, no timers, no continuation, unmounted)');
