// Startup tooling only: never opens the database or runs business logic.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
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

export async function prepareLocalPorts({ root, host, ports }, io = {}) {
  const inspect = io.inspect ?? lsof;
  const signal = io.signal ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = io.log ?? console.error;
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
    return cwd.split("\n").includes(`n${root}`) && exe.split("\n").some(line => /^n.*\/stock-info-local$/.test(line));
  };
  const pids = listeners();
  // Validate BOTH ports before stopping anything. Another checkout is unrelated.
  for (const pid of pids) {
    if (!owned(pid)) throw new Error(`Port ${ports.join("/")} occupied by unrelated or unidentifiable PID ${pid}; no services stopped.`);
  }
  for (const pid of pids) {
    if (!owned(pid)) throw new Error(`PID ${pid} changed before shutdown; refusing to signal it.`);
    log(`Stopping previous stock-info instance PID ${pid} (SIGTERM; waiting for accepted tasks).`);
    try { signal(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  // Wait for process exit, not merely socket closure: accepted jobs may still run.
  for (let attempt = 0; attempt <= 120; attempt++) {
    const alive = pids.filter(pid => {
      try { signal(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
    });
    if (!alive.length) {
      if (listeners().length) throw new Error("A new listener occupied a local port during shutdown; refusing to stop it.");
      return;
    }
    if (attempt === 120) throw new Error(`Previous instance still draining after 30s (PID ${alive.join(", ")}); retry after it exits. No force kill performed.`);
    await sleep(250);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await prepareLocalPorts({ root: realpathSync(process.cwd()), host: process.env.HOST || "127.0.0.1", ports: [process.env.PORT || "8000", process.env.KNOWLEDGE_CONTENT_LOCAL_PORT || process.env.LOCAL_CONTENT_PORT || "8788"] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
