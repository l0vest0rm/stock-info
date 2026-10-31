import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLocalPorts } from '../prepare-local-ports.mjs';
const config = { root: '/checkout', host: '127.0.0.1', ports: ['18000', '18788'] };
function fixture({ foreign = false, stuck = false, race = false } = {}) {
  let alive = true, checks = 0;
  const signals = [];
  return {
    signals,
    inspect(args) {
      if (args.includes('-Fp')) {
        if (!alive) return race ? 'p99\n' : '';
        return args.includes('-iTCP:18000') ? 'p42\n' : foreign ? 'p99\n' : 'p42\n';
      }
      if (args.includes('cwd')) return `p${args[2]}\nn${args[2] === '99' ? '/other-checkout' : '/checkout'}\n`;
      return `p${args[2]}\nn/target/debug/stock-info-local\n`;
    },
    signal(pid, sig) {
      if (sig === 'SIGTERM') signals.push(pid);
      else if (!stuck && ++checks > 1) { alive = false; throw Object.assign(new Error(), { code: 'ESRCH' }); }
    },
    sleep: async () => {}, log() {},
  };
}
test('deduplicates both listeners, SIGTERMs once and waits for exit', async () => {
  const io = fixture(); await prepareLocalPorts(config, io); assert.deepEqual(io.signals, [42]);
});
test('preflights both ports before stopping any instance', async () => {
  const io = fixture({ foreign: true });
  await assert.rejects(prepareLocalPorts(config, io), /unrelated/); assert.deepEqual(io.signals, []);
});
test('does not force kill jobs still draining after timeout', async () => {
  const io = fixture({ stuck: true });
  await assert.rejects(prepareLocalPorts(config, io), /No force kill/); assert.deepEqual(io.signals, [42]);
});
test('does not stop a new listener appearing during shutdown', async () => {
  const io = fixture({ race: true });
  await assert.rejects(prepareLocalPorts(config, io), /new listener/); assert.deepEqual(io.signals, [42]);
});
test('invalid configuration never inspects or stops processes', async () => {
  const io = { inspect() { assert.fail('unexpected inspection'); } };
  for (const changes of [{ host: '0.0.0.0' }, { ports: ['8000', '8000'] }, { ports: ['0', '8788'] }]) {
    await assert.rejects(prepareLocalPorts({ ...config, ...changes }, io));
  }
});
