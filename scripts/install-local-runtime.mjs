// Build/install tooling only. Never starts a service or opens its database.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Trusted local shell may contain quoted OR bare assignment values. A raw
// replacement breaks bare paths when the install root contains spaces.
export function rebaseShellPaths(source, from, to) {
  let result = '', quote = '';
  for (let i = 0; i < source.length;) {
    if (source.startsWith(from, i)) {
      result += quote === '"' ? to.replace(/[\\$`\"]/g, '\\$&')
        : quote === "'" ? to.replaceAll("'", "'\\''") : `'${to.replaceAll("'", "'\\''")}'`;
      i += from.length;
      continue;
    }
    const char = source[i++];
    result += char;
    if (char === '\\' && quote !== "'" && i < source.length) result += source[i++];
    else if (char === quote) quote = '';
    else if (!quote && (char === "'" || char === '"')) quote = char;
  }
  return result;
}

export function assertDatabaseClosed(file) {
  if (!existsSync(file)) return;
  let output;
  try { output = execFileSync('lsof', ['-t', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    if (error.status === 1 && !error.stdout && !error.stderr) return;
    throw new Error('Cannot verify SQLite is closed; no runtime data copied', { cause: error });
  }
  if (output.trim()) throw new Error('SQLite is still open; wait for all old server/CLI tasks to exit before installing');
}

export function validateDestination(root, destination) {
  root = realpathSync(root);
  destination = resolve(destination);
  mkdirSync(dirname(destination), { recursive: true });
  // Resolve existing parents too: a symlink must not put the runtime back on pssd.
  const parent = realpathSync(dirname(destination));
  destination = join(parent, destination.split('/').at(-1));
  if (existsSync(destination)) destination = realpathSync(destination);
  if (destination === root || destination.startsWith(`${root}/`) || destination.startsWith('/Volumes/')) {
    throw new Error('Runtime must be outside the checkout and external /Volumes disks');
  }
  const marker = join(destination, '.stock-info-runtime');
  if (existsSync(destination) && (!existsSync(marker) || readFileSync(marker, 'utf8').trim() !== root)) {
    throw new Error('Refusing to overwrite an unowned runtime directory');
  }
  if (existsSync(`${destination}.install-lock`)) throw new Error('Runtime install lock exists; no services stopped');
  return destination;
}

export function installRuntime({ root, destination, binary, captureHost }) {
  root = realpathSync(root);
  destination = validateDestination(root, destination);
  const lock = `${destination}.install-lock`;
  mkdirSync(lock); // Exclusive owner; never steal a concurrent install's lock.
  const stage = `${destination}.stage-${process.pid}`;
  const marker = '.stock-info-runtime';
  try {
    const existing = existsSync(destination);
    if (existing && (!existsSync(join(destination, marker)) || readFileSync(join(destination, marker), 'utf8').trim() !== root)) {
      throw new Error('Refusing to overwrite an unowned runtime directory');
    }
    assertDatabaseClosed(join(existing ? destination : root, 'data/local/stock-info.sqlite'));
    mkdirSync(stage, { mode: 0o700 });
    const copy = (source, target) => {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, dereference: true, preserveTimestamps: true });
    };
    for (const resource of ['config', 'migrations', 'prompts', 'web/dist']) copy(join(root, resource), join(stage, resource));
    for (const script of ['extract-featured-report.py', 'local-runtime-env.sh']) copy(join(root, 'scripts', script), join(stage, 'scripts', script));
    copy(binary, join(stage, 'bin/stock-info-local'));
    if (captureHost) copy(captureHost, join(stage, 'bin/app-capture-host'));
    copy(join(root, 'scripts/run-installed.sh'), join(stage, 'start.sh'));
    chmodSync(join(stage, 'start.sh'), 0o700);
    if (!existing) {
      // Caller must drain the old server first. Copy closed SQLite + objects
      // together, not a live DB/WAL pair or a partial online snapshot.
      if (existsSync(join(root, 'data'))) copy(join(root, 'data'), join(stage, 'data'));
      if (existsSync(join(root, '.dev.vars'))) copy(join(root, '.dev.vars'), join(stage, '.dev.vars'));
      for (const file of ['.dev.vars', 'data/local/acquisition-runtime.env']) {
        const path = join(stage, file);
        if (existsSync(path)) {
          const content = readFileSync(path, 'utf8');
          writeFileSync(path, file.endsWith('.env') ? rebaseShellPaths(content, root, destination) : content.replaceAll(root, destination), { mode: 0o600 });
          chmodSync(path, 0o600);
        }
      }
      writeFileSync(join(stage, marker), `${root}\n`, { mode: 0o600 });
      renameSync(stage, destination);
    } else {
      // Data, cookies, credentials and runtime-local state are never re-seeded.
      const resources = ['config', 'migrations', 'prompts', 'web', 'scripts', 'bin', 'start.sh'];
      for (const resource of resources) {
        if (existsSync(join(destination, `${resource}.previous`))) throw new Error('Unfinished resource update; restore .previous resources before retrying');
      }
      const replaced = [];
      try {
        for (const resource of resources) {
          const target = join(destination, resource), old = `${target}.previous`;
          const hadPrevious = existsSync(target);
          if (hadPrevious) renameSync(target, old);
          replaced.push({ target, old, hadPrevious });
          renameSync(join(stage, resource), target);
        }
      } catch (error) {
        for (const { target, old, hadPrevious } of replaced.reverse()) {
          rmSync(target, { recursive: true, force: true });
          if (hadPrevious) renameSync(old, target);
        }
        throw error;
      }
      for (const { old } of replaced) rmSync(old, { recursive: true, force: true });
    }
    return destination;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [root, destination, binary] = process.argv.slice(2);
    if (!root || !destination || !binary) throw new Error('Expected ROOT DESTINATION BINARY');
    if (process.argv[5] === '--check') { validateDestination(root, destination); }
    else {
      if (!process.argv[6]) throw new Error('Managed app-capture-host binary is required for installation');
      installRuntime({ root, destination, binary, captureHost: process.argv[6] });
      console.error(`Standalone runtime ready: ${destination}/start.sh`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
