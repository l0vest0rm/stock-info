import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLocalPorts } from '../prepare-local-ports.mjs';
const config = { root: '/checkout', host: '127.0.0.1', ports: ['18000', '18788'] };
function fixture({ foreign = false, stuck = false, race = false } = {}) {
  let alive = true, checks = 0;
  const signals = [];
  return {
    signals,
    identity: () => "birth-42",
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
test('automatically waits beyond 30s without force killing or manual retry', async () => {
  const io = fixture({ stuck: true });
  let sleeps = 0, done = false;
  io.sleep = async () => { if (++sleeps === 160) done = true; };
  io.identity = () => done ? '' : 'birth-42';
  const inspect = io.inspect;
  io.inspect = args => done && args.includes('-Fp') ? '' : inspect(args);
  await prepareLocalPorts(config, io);
  assert.equal(sleeps, 160); assert.deepEqual(io.signals, [42]);
});
test('retry rejoins a listenerless draining process without signaling it again', async () => {
  const io = fixture(); let pending = [{pid: 42, birth: 'birth-42'}];
  io.inspect = args => args.includes('-Fp') ? '' : '';
  io.readPending = () => pending; io.writePending = entries => { pending = entries; };
  await prepareLocalPorts(config, io);
  assert.deepEqual(io.signals, []); assert.deepEqual(pending, []);
});
test('stale drain ticket cannot target a reused PID', async () => {
  const io = fixture(); io.inspect = () => '';
  io.readPending = () => [{pid: 42, birth: 'old-birth'}];
  io.signal = () => assert.fail('reused PID must not be touched');
  await prepareLocalPorts(config, io);
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
test('accepts installed instance only with exact runtime cwd and executable', async () => {
  const io = fixture();
  const original = io.inspect;
  io.inspect = args => args.includes('cwd') ? 'n/internal/runtime\n' : args.includes('txt') ? 'n/internal/runtime/bin/stock-info-local\n' : original(args);
  await prepareLocalPorts({ ...config, runtimeRoot: '/internal/runtime' }, io);
  assert.deepEqual(io.signals, [42]);
  const foreign = fixture();
  const foreignOriginal = foreign.inspect;
  foreign.inspect = args => args.includes('cwd') ? 'n/internal/runtime\n' : args.includes('txt') ? 'n/another/bin/stock-info-local\n' : foreignOriginal(args);
  await assert.rejects(prepareLocalPorts({ ...config, runtimeRoot: '/internal/runtime' }, foreign), /unrelated/);
  assert.deepEqual(foreign.signals, []);
});

test('writes a recoverable drain ticket before sending SIGTERM', async () => {
  const io = fixture(); let pending = [];
  io.readPending = () => pending;
  io.writePending = entries => { pending = entries; };
  const signal = io.signal;
  io.signal = (pid, sig) => {
    if (sig === 'SIGTERM') assert.deepEqual(pending, [{pid: 42, birth: 'birth-42'}]);
    return signal(pid, sig);
  };
  await prepareLocalPorts(config, io);
  assert.deepEqual(pending, []);
});
test('refuses to signal a PID whose birth identity changed after preflight', async () => {
  const io = fixture(); let checks = 0;
  io.identity = () => ++checks === 1 ? 'first-birth' : 'reused-birth';
  await assert.rejects(prepareLocalPorts(config, io), /changed before shutdown/);
  assert.deepEqual(io.signals, []);
});
