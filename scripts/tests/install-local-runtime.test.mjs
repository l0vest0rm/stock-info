import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { installRuntime, validateDestination, assertDatabaseClosed } from '../install-local-runtime.mjs';

test('managed helper updates on rebuild and runs without the checkout', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stock-info-capture-install-')));
  const root = join(base, 'checkout'), destination = join(base, 'runtime');
  const put = (p, body) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), body); };
  try {
    for (const path of ['config/a', 'migrations/a', 'prompts/a', 'web/dist/a']) put(path, 'fixture');
    put('scripts/local-runtime-env.sh', ':\n');
    put('scripts/extract-featured-report.py', '# fixture\n');
    put('scripts/run-installed.sh', readFileSync(new URL('../run-installed.sh', import.meta.url)));
    put('data/local/acquisition-runtime.env', `if [ -z "\${APP_CAPTURE_HOST:-}" ]; then export APP_CAPTURE_HOST='${root}/old-host'; fi\n`);
    put('binary', '#!/bin/sh\nprintf "%s\\n" "$APP_CAPTURE_HOST"\n');
    put('helper', '#!/bin/sh\necho helper-v1\n');
    for (const p of ['binary', 'helper']) execFileSync('chmod', ['+x', join(root, p)]);
    const options = { root, destination, binary: join(root, 'binary'), captureHost: join(root, 'helper') };
    installRuntime(options);
    put('helper', '#!/bin/sh\necho helper-v2\n');
    installRuntime(options);
    renameSync(root, `${root}.unavailable`);
    const env = { ...process.env, APP_CAPTURE_HOST: '' };
    const helper = execFileSync(join(destination, 'start.sh'), { cwd: '/', env, encoding: 'utf8' }).trim();
    assert.equal(helper, join(destination, 'bin/app-capture-host'));
    assert.equal(execFileSync(helper, { cwd: '/', encoding: 'utf8' }).trim(), 'helper-v2');
    assert.equal(execFileSync(join(destination, 'start.sh'), {
      cwd: '/', env: { ...env, APP_CAPTURE_HOST: '/explicit/internal/helper' }, encoding: 'utf8'
    }).trim(), '/explicit/internal/helper');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('independent launcher, copied private state, path rebasing and non-destructive rebuild', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stock-info-install-')));
  const root = join(base, 'checkout'), destination = join(base, 'internal runtime');
  const put = (p, body) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), body); };
  try {
    for (const path of ['config/app/test.json', 'migrations/0001.sql', 'prompts/a.md', 'web/dist/index.html', 'data/local/stock-info.sqlite']) put(path, path);
    put('.dev.vars', `LOCAL_DATA_DIR=${root}/data/local\n`);
    put('data/local/acquisition-runtime.env', `export CAPTURE_PATH='${root}/data/local/bin/host'\nexport BARE_PATH=${root}/data/local/bin/host\n`);
    put('scripts/local-runtime-env.sh', ':\n');
    put('scripts/extract-featured-report.py', '# test\n');
    put('scripts/run-installed.sh', readFileSync(new URL('../run-installed.sh', import.meta.url)));
    put('binary', '#!/bin/sh\nprintf "%s\\n" "$PWD" "$CAPTURE_PATH" "$BARE_PATH"\ncat web/dist/index.html\n');
    installRuntime({ root, destination, binary: join(root, 'binary') });
    // Fake native executable for the launcher test.
    execFileSync('chmod', ['+x', join(destination, 'bin/stock-info-local')]);
    renameSync(root, `${root}.unavailable`);
    const output = execFileSync(join(destination, 'start.sh'), { cwd: '/', encoding: 'utf8' });
    assert.ok(output.includes(destination));
    assert.ok(output.includes(`${destination}/data/local/bin/host`));
    assert.ok(!output.includes(root));
    assert.equal(output.split(`${destination}/data/local/bin/host`).length - 1, 2);
    renameSync(`${root}.unavailable`, root);
    assert.equal(readFileSync(join(destination, '.dev.vars'), 'utf8'), `LOCAL_DATA_DIR=${destination}/data/local\n`);
    writeFileSync(join(destination, 'data/local/stock-info.sqlite'), 'new durable data');
    writeFileSync(join(destination, '.dev.vars'), 'private updated credential');
    installRuntime({ root, destination, binary: join(root, 'binary') });
    assert.equal(readFileSync(join(destination, 'data/local/stock-info.sqlite'), 'utf8'), 'new durable data');
    assert.equal(readFileSync(join(destination, '.dev.vars'), 'utf8'), 'private updated credential');
    assert.ok(existsSync(join(root, 'data/local/stock-info.sqlite')));
    assert.throws(() => validateDestination(root, root), /outside/);
    assert.throws(() => validateDestination(root, '/Volumes/test-runtime'), /outside/);
    assert.throws(() => validateDestination(root, base), /unowned/);
    mkdirSync(`${destination}.install-lock`);
    assert.throws(() => installRuntime({ root, destination, binary: join(root, 'binary') }), /lock/);
    assert.ok(existsSync(`${destination}.install-lock`));
  } finally { rmSync(base, { recursive: true, force: true }); }
});


test('refuses copying a database held open by a draining process', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stock-info-db-open-'));
  const db = join(base, 'stock-info.sqlite');
  writeFileSync(db, 'test');
  const child = spawn(process.execPath, ['-e', "const fs=require('fs');fs.openSync(process.argv[1],'r');console.log('ready');setInterval(()=>{},1000)", db]);
  try {
    await new Promise(resolve => child.stdout.once('data', resolve));
    assert.throws(() => assertDatabaseClosed(db), /still open/);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
    rmSync(base, { recursive: true, force: true });
  }
});

test('real standalone API/page works without source or build tools', { skip: !process.env.STOCK_INFO_TEST_BINARY }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stock-info-native-')));
  const root = join(base, 'source'), destination = join(base, 'runtime');
  const repository = new URL('../../', import.meta.url);
  let child;
  try {
    mkdirSync(root);
    for (const resource of ['config', 'migrations', 'prompts', 'web/dist', 'scripts']) {
      mkdirSync(join(root, resource, '..'), { recursive: true });
      cpSync(new URL(resource, repository), join(root, resource), { recursive: true });
    }
    installRuntime({ root, destination, binary: process.env.STOCK_INFO_TEST_BINARY });
    renameSync(root, `${root}.unavailable`);
    const { createServer } = await import('node:net');
    const unusedPort = async () => {
      const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
    };
    const port = await unusedPort(), content = await unusedPort();
    child = spawn(join(destination, 'start.sh'), [], { cwd: '/', env: {
      HOME: process.env.HOME, PATH: '/usr/bin:/bin', PORT: String(port), KNOWLEDGE_CONTENT_LOCAL_PORT: String(content),
      LOCAL_SCHEDULER: '0', XUEQIU_COOKIE_REFRESH: '0',
    }, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = ''; child.stderr.on('data', chunk => { log += chunk; });
    const url = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      try { const res = await fetch(`${url}/api/health`); healthy = res.ok; if (healthy) break; } catch {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, log.slice(-2000));
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.data.runtime, 'rust');
    for (const path of ['/', '/api/research/portfolio/workspace', '/api/local/acquisitions']) {
      assert.equal((await fetch(`${url}${path}`)).status, 200, path);
    }
    assert.ok(existsSync(join(destination, 'data/local/stock-info.sqlite')));
    assert.ok(!existsSync(join(root, 'data/local/stock-info.sqlite')));
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
    }
    rmSync(base, { recursive: true, force: true });
  }
});
