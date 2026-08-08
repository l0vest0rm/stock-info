import { spawn } from "node:child_process";

const statusMarker = "\n__LOCAL_WORKER_STATUS__:";

// Miniflare's local ProxyController loses its loopback connection after
// repeated requests made through Node's HTTP clients (both Undici and
// node:http). Keep the local Worker boundary outside that client stack. Each
// curl child owns one request and is fully reaped before the next poll.
export async function fetchLocalWorker(url, init = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:") {
    throw new Error(`local Worker URL must use http:, received ${target.protocol}`);
  }
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  const args = ["--silent", "--show-error", "--request", init.method || "GET", "--url", target.toString()];
  for (const [name, value] of headers) args.push("--header", `${name}: ${value}`);
  if (init.body !== undefined && init.body !== null) args.push("--data-binary", "@-");
  args.push("--write-out", `${statusMarker}%{http_code}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.LOCAL_WORKER_CURL_BIN || "curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const abort = () => child.kill("SIGTERM");
    if (init.signal) init.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (init.signal) init.signal.removeEventListener("abort", abort);
      if (code !== 0) {
        reject(new Error(`local Worker curl failed (exit=${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      const markerIndex = output.lastIndexOf(statusMarker);
      const status = Number(output.slice(markerIndex + statusMarker.length));
      if (markerIndex < 0 || !Number.isInteger(status) || status < 100 || status > 599) {
        reject(new Error("local Worker curl returned no valid HTTP status"));
        return;
      }
      resolve(new Response(output.slice(0, markerIndex), { status }));
    });
    child.stdin.end(init.body === undefined || init.body === null ? undefined : init.body);
  });
}
