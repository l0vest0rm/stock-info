// Startup tooling only: never opens the database or runs business logic.
import { execFileSync } from "node:child_process";
import { realpathSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

function lsof(args) {
  try {
    return execFileSync("lsof", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error.status === 1 && !error.stdout && !error.stderr) return "";
    throw new Error("Cannot inspect listening processes with lsof; no services stopped.", { cause: error });
  }
}

export async function prepareLocalPorts({ root, runtimeRoot, host, ports }, io = {}) {
  const inspect = io.inspect ?? lsof;
  const signal = io.signal ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = io.log ?? console.error;
  const identity = io.identity ?? (pid => {
    try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim(); }
    catch (error) { if (error.status === 1) return ""; throw error; }
  });
  const readPending = io.readPending ?? (() => []);
  const writePending = io.writePending ?? (() => {});
  if (!isIP(host) || !(host.startsWith("127.") || host === "::1")) throw new Error("HOST must be a loopback IP address");
  if (ports.some(port => !/^[0-9]+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) || Number(ports[0]) === Number(ports[1])) {
    throw new Error("API/content ports must be distinct integers between 1 and 65535");
  }
  const listeners = () => [...new Set(ports.flatMap(port =>
    inspect(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"])
      .split("\n").filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1)))) )];
  const owned = pid => {
    const cwd = inspect(["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const exe = inspect(["-a", "-p", String(pid), "-d", "txt", "-Fn"]);
    const checkout = cwd.split("\n").includes(`n${root}`) && exe.split("\n").some(line => /^n.*\/stock-info-local$/.test(line));
    const installed = runtimeRoot && cwd.split("\n").includes(`n${runtimeRoot}`) && exe.split("\n").includes(`n${runtimeRoot}/bin/stock-info-local`);
    return checkout || installed;
  };
  const pids = listeners();
  const pending = readPending().filter(entry => entry && Number.isInteger(entry.pid) && entry.pid > 0 && typeof entry.birth === "string" && entry.birth && identity(entry.pid) === entry.birth);
  // Validate BOTH ports before stopping anything. Another checkout is unrelated.
  for (const pid of pids) {
    if (!owned(pid)) throw new Error(`Port ${ports.join("/")} occupied by unrelated or unidentifiable PID ${pid}; no services stopped.`);
  }
  const tracked = new Map(pending.map(entry => [entry.pid, entry]));
  for (const pid of pids) {
    const birth = identity(pid);
    if (birth) tracked.set(pid, { pid, birth });
  }
  // Persist BEFORE signaling: an interrupted startup can rejoin a listenerless
  // drain on retry. Birth identity prevents waiting on or signaling a reused PID.
  writePending([...tracked.values()]);
  for (const pid of pids) {
    const birth = identity(pid);
    if (!birth) continue;
    if (tracked.get(pid)?.birth !== birth || !owned(pid)) throw new Error(`PID ${pid} changed before shutdown; refusing to signal it.`);
    log(`Stopping previous stock-info instance PID ${pid} (SIGTERM; waiting for accepted tasks).`);
    try { signal(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  // Wait for process exit, not merely socket closure: accepted jobs may still run.
  for (let attempt = 0; ; attempt++) {
    const alive = [...tracked.values()].filter(({pid, birth}) => {
      if (identity(pid) !== birth) return false;
      try { signal(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
    });
    if (!alive.length) {
      writePending([]);
      if (listeners().length) throw new Error("A new listener occupied a local port during shutdown; refusing to stop it.");
      return;
    }
    if (attempt > 0 && attempt % 40 === 0) log(`Waiting for safe shutdown (${attempt / 4}s; PID ${alive.map(entry => entry.pid).join(", ")}). Startup will continue automatically; no force kill.`);
    await sleep(250);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = realpathSync(process.cwd());
    const candidate = process.env.LOCAL_RUNTIME_DIR;
    const marker = candidate && join(candidate, '.stock-info-runtime');
    const runtimeRoot = marker && existsSync(marker) && readFileSync(marker, 'utf8').trim() === root ? realpathSync(candidate) : undefined;
    const pendingPath = join(runtimeRoot || root, '.stock-info-draining.json');
    const pendingIO = {
      readPending: () => existsSync(pendingPath) ? JSON.parse(readFileSync(pendingPath, 'utf8')) : [],
      writePending: entries => {
        if (!entries.length) { if (existsSync(pendingPath)) unlinkSync(pendingPath); return; }
        const temp = `${pendingPath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 });
        renameSync(temp, pendingPath);
      },
    };
    await prepareLocalPorts({ root, runtimeRoot, host: process.env.HOST || "127.0.0.1", ports: [process.env.PORT || "8000", process.env.KNOWLEDGE_CONTENT_LOCAL_PORT || process.env.LOCAL_CONTENT_PORT || "8788"] }, pendingIO);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
