import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import { mapClsTelegraphItem } from "./cls-news.mjs";

const DEFAULT_INPUT_DIR = "/Users/terry/git/data/news";

export function createSub2meCallbackHandler({ task = "cls-telegraph", inputDir = DEFAULT_INPUT_DIR } = {}) {
  const token = randomBytes(32).toString("base64url");
  const seenByFile = new Map();
  const storeRecord = (record) => {
    const doc = mapClsTelegraphItem(record);
    const dir = resolve(inputDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `cls-telegraph-${doc.publishedAt.slice(0, 10)}.jsonl`);
    if (!seenByFile.has(file)) {
      const seen = new Set();
      if (existsSync(file)) for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
        seen.add(JSON.parse(line).docId);
      }
      seenByFile.set(file, seen);
    }
    const seen = seenByFile.get(file);
    if (seen.has(doc.docId)) return { status: "duplicate", doc_id: doc.docId };
    appendFileSync(file, `${JSON.stringify(doc)}\n`);
    seen.add(doc.docId);
    return { status: "stored", doc_id: doc.docId };
  };
  const handle = async (request, response) => {
    const pathname = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`).pathname;
    if (pathname !== "/api/local/sub2me/callback") return false;
    if (request.method !== "POST") return reply(response, 405, { error: "method not allowed" });
    const supplied = request.headers.authorization?.replace(/^Bearer /i, "") || "";
    const expectedBytes = Buffer.from(token);
    const suppliedBytes = Buffer.from(supplied);
    if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      return reply(response, 401, { error: "unauthorized" });
    }
    let payload;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) return reply(response, 413, { error: "payload too large" });
        chunks.push(chunk);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(response, 400, { error: "invalid JSON" });
    }
    if (payload?.task !== task || !payload?.record || typeof payload.record !== "object") {
      return reply(response, 400, { error: "invalid task or record" });
    }
    let result;
    try { result = storeRecord(payload.record); }
    catch (error) { return reply(response, 422, { error: String(error) }); }
    return reply(response, 200, result);
  };
  return { handle, storeRecord, token };
}

export async function registerSub2meSubscription({ baseUrl, callbackUrl, token, task = "cls-telegraph", onRecord }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `stock-info-${task}`,
      target_type: "task",
      target_value: task,
      channel: "callback",
      config: {
        url: callbackUrl,
        headers: { Authorization: `Bearer ${token}` },
        params: { consumer: "stock-info" },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Sub2Me subscription failed: HTTP ${response.status} ${await response.text()}`);
  const subscription = await response.json();
  let before;
  let stored = 0;
  while (onRecord) {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/records`);
    url.searchParams.set("task", task);
    url.searchParams.set("limit", "1000");
    if (before) url.searchParams.set("before", String(before));
    const pageResponse = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!pageResponse.ok) throw new Error(`Sub2Me backfill failed: HTTP ${pageResponse.status}`);
    const page = await pageResponse.json();
    if (!Array.isArray(page)) throw new Error("Sub2Me backfill returned invalid records");
    for (const row of page) if (onRecord(row.data).status === "stored") stored += 1;
    if (page.length < 1000) break;
    const next = Number(page.at(-1)?.id);
    if (!Number.isInteger(next) || next <= 0 || (before && next >= before)) throw new Error("Sub2Me backfill cursor did not advance");
    before = next;
  }
  return { ...subscription, stored };
}

function reply(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
  return true;
}
