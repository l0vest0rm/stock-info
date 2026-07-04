import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const defaultContentType = "text/markdown; charset=utf-8";
const execFileAsync = promisify(execFile);

export function buildContentOptions(args = {}) {
  const remote = args.remote === true;
  const uploadContentRemote = args.uploadContentRemote === true;
  const s3AccessKeyId = text(process.env.CLOUDFLARE_R2_ACCESS_KEY_ID);
  const s3SecretAccessKey = text(process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY);
  const s3Endpoint = text(process.env.CLOUDFLARE_R2_ENDPOINT).replace(/\/+$/, "");
  const useRemoteS3 = uploadContentRemote && Boolean(s3AccessKeyId && s3SecretAccessKey && s3Endpoint);
  return {
    bucket: text(args.contentBucket || process.env.KNOWLEDGE_CONTENT_BUCKET || "stock-info-knowledge-content"),
    publicBaseUrl: text(args.contentPublicBaseUrl || process.env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL || "https://content.tinfo.cc"),
    localContentDir: resolve(text(args.localContentDir || process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || "/Users/terry/git/data/stock-info/knowledge/content-cache")),
    minCompressBytes: positiveInteger(process.env.KNOWLEDGE_CONTENT_COMPRESS_MIN_BYTES, 4096),
    uploadConcurrency: positiveInteger(process.env.KNOWLEDGE_CONTENT_UPLOAD_CONCURRENCY, remote ? 8 : 1),
    uploadRetryCount: positiveInteger(process.env.KNOWLEDGE_CONTENT_UPLOAD_RETRY_COUNT, remote ? 2 : 4),
    uploadConnectTimeoutSeconds: positiveInteger(process.env.KNOWLEDGE_CONTENT_UPLOAD_CONNECT_TIMEOUT_SECONDS, 10),
    uploadMaxTimeSeconds: positiveInteger(process.env.KNOWLEDGE_CONTENT_UPLOAD_MAX_TIME_SECONDS, 180),
    uploadLowSpeedLimitBytes: positiveInteger(process.env.KNOWLEDGE_CONTENT_UPLOAD_LOW_SPEED_LIMIT_BYTES, 1024),
    uploadLowSpeedTimeSeconds: positiveInteger(process.env.KNOWLEDGE_CONTENT_UPLOAD_LOW_SPEED_TIME_SECONDS, 30),
    s3AccessKeyId,
    s3SecretAccessKey,
    s3Endpoint,
    useRemoteS3,
  };
}

export function prepareKnowledgeContent({ docId, markdown, remote, options }) {
  const prepared = prepareKnowledgeContentPayload({ docId, markdown, options, remote });
  if (!prepared.contentKey) {
    return prepared;
  }
  if (!remote) {
    writeLocalContentFile({ options, key: prepared.contentKey, payload: prepared.payload });
  }
  if (!remote && !options.useRemoteS3) return stripPayload(prepared);
  uploadKnowledgeContent({
    options,
    bucket: options.bucket,
    key: prepared.contentKey,
    payload: prepared.payload,
    encoding: prepared.contentEncoding,
    remote,
  });
  return stripPayload(prepared);
}

export function planKnowledgeContent({ docId, markdown, remote, options }) {
  return stripPayload(prepareKnowledgeContentPayload({ docId, markdown, options, remote }));
}

export async function prepareKnowledgeContentAsync({ docId, markdown, remote, options }) {
  const prepared = prepareKnowledgeContentPayload({ docId, markdown, options, remote });
  if (!prepared.contentKey) {
    return prepared;
  }
  if (!remote) {
    writeLocalContentFile({ options, key: prepared.contentKey, payload: prepared.payload });
  }
  if (!remote && !options.useRemoteS3) return stripPayload(prepared);
  await uploadKnowledgeContentAsync({
    options,
    bucket: options.bucket,
    key: prepared.contentKey,
    payload: prepared.payload,
    encoding: prepared.contentEncoding,
    remote,
  });
  return stripPayload(prepared);
}

function prepareKnowledgeContentPayload({ docId, markdown, options, remote }) {
  const body = text(markdown);
  if (!body) {
    return emptyContent();
  }
  const raw = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const compressed = raw.length >= options.minCompressBytes
    ? brotliCompressSync(raw, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
    })
    : null;
  const useBrotli = Boolean(compressed && compressed.length < raw.length);
  const payload = useBrotli ? compressed : raw;
  const encoding = useBrotli ? "br" : "identity";
  const key = knowledgeContentKey(docId, sha256, encoding);
  return {
    contentKey: key,
    contentUrl: joinPublicUrl(options.publicBaseUrl, key),
    contentType: defaultContentType,
    contentEncoding: encoding,
    contentBytes: payload.length,
    contentSha256: sha256,
    contentPreview: markdownPreview(body),
    payload,
  };
}

export function markdownPreview(value, max = 280) {
  const preview = text(value)
    .replace(/\*\*==>\s*picture\s*\[[^\]]+\]\s*intentionally omitted\s*<==\*\*/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return preview.length <= max ? preview : `${preview.slice(0, max).trimEnd()}...`;
}

function uploadKnowledgeContent({ options, bucket, key, payload, encoding, remote }) {
  const dir = mkdtempSync(join(tmpdir(), "stock-info-knowledge-content-"));
  const file = join(dir, encoding === "br" ? "content.md.br" : "content.md");
  try {
    writeFileSync(file, payload);
    if (options.useRemoteS3) {
      runS3PutWithRetry({
        bucket,
        key,
        file,
        encoding,
        retryCount: options.uploadRetryCount,
        accessKeyId: options.s3AccessKeyId,
        secretAccessKey: options.s3SecretAccessKey,
        endpoint: options.s3Endpoint,
        options,
      });
      return;
    }
    runR2PutWithRetry({
      bucket,
      key,
      file,
      encoding,
      remote,
      retryCount: buildContentOptions({ remote }).uploadRetryCount,
    });
  } catch (err) {
    if (err.stdout) process.stderr.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function uploadKnowledgeContentAsync({ options, bucket, key, payload, encoding, remote }) {
  const dir = mkdtempSync(join(tmpdir(), "stock-info-knowledge-content-"));
  const file = join(dir, encoding === "br" ? "content.md.br" : "content.md");
  try {
    writeFileSync(file, payload);
    if (options.useRemoteS3) {
      await runS3PutWithRetryAsync({
        bucket,
        key,
        file,
        encoding,
        retryCount: options.uploadRetryCount,
        accessKeyId: options.s3AccessKeyId,
        secretAccessKey: options.s3SecretAccessKey,
        endpoint: options.s3Endpoint,
        options,
      });
      return;
    }
    await runR2PutWithRetryAsync({
      bucket,
      key,
      file,
      encoding,
      remote,
      retryCount: buildContentOptions({ remote }).uploadRetryCount,
    });
  } catch (err) {
    if (err.stdout) process.stderr.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function r2PutCommand({ bucket, key, file, encoding, remote }) {
  const command = [
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    remote ? "--remote" : "--local",
    "--file",
    file,
    "--content-type",
    defaultContentType,
    "--cache-control",
    "public, max-age=31536000, immutable",
    "--force",
  ];
  if (encoding === "br") {
    command.push("--content-encoding", "br");
  }
  return command;
}

function s3PutCommand({ bucket, key, file, encoding, accessKeyId, secretAccessKey, endpoint, options }) {
  const command = [
    "--fail",
    "--silent",
    "--show-error",
    "--connect-timeout",
    String(options.uploadConnectTimeoutSeconds),
    "--max-time",
    String(options.uploadMaxTimeSeconds),
    "--speed-limit",
    String(options.uploadLowSpeedLimitBytes),
    "--speed-time",
    String(options.uploadLowSpeedTimeSeconds),
    "--aws-sigv4",
    "aws:amz:auto:s3",
    "--user",
    `${accessKeyId}:${secretAccessKey}`,
    "--request",
    "PUT",
    "--upload-file",
    file,
    "--header",
    `Content-Type: ${defaultContentType}`,
    "--header",
    "Cache-Control: public, max-age=31536000, immutable",
  ];
  if (encoding === "br") {
    command.push("--header", "Content-Encoding: br");
  }
  command.push(`${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  return command;
}

function isRetryableWranglerR2Error(error) {
  const message = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`.toLowerCase();
  return message.includes("network connection lost")
    || message.includes("fetch failed")
    || message.includes("socket hang up")
    || message.includes("econnreset")
    || message.includes("etimedout");
}

function isRetryableS3Error(error) {
  const message = `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`.toLowerCase();
  return message.includes("500")
    || message.includes("502")
    || message.includes("503")
    || message.includes("504")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("connection")
    || message.includes("reset")
    || message.includes("temporarily unavailable");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runR2PutWithRetry({ bucket, key, file, encoding, remote, retryCount }) {
  const command = r2PutCommand({ bucket, key, file, encoding, remote });
  let attempt = 0;
  while (true) {
    try {
      execFileSync("npx", command, { stdio: "pipe", encoding: "utf8" });
      return;
    } catch (error) {
      attempt += 1;
      if (attempt > retryCount || !isRetryableWranglerR2Error(error)) {
        throw error;
      }
      console.error(`[knowledge-content] retrying local R2 put attempt=${attempt} key=${key}`);
      sleepMs(Math.min(2000, attempt * 400));
    }
  }
}

async function runR2PutWithRetryAsync({ bucket, key, file, encoding, remote, retryCount }) {
  const command = r2PutCommand({ bucket, key, file, encoding, remote });
  let attempt = 0;
  while (true) {
    try {
      await execFileAsync("npx", command, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return;
    } catch (error) {
      attempt += 1;
      if (attempt > retryCount || !isRetryableWranglerR2Error(error)) {
        throw error;
      }
      console.error(`[knowledge-content] retrying local R2 put attempt=${attempt} key=${key}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, attempt * 400)));
    }
  }
}

function runS3PutWithRetry({ bucket, key, file, encoding, retryCount, accessKeyId, secretAccessKey, endpoint, options }) {
  const command = s3PutCommand({ bucket, key, file, encoding, accessKeyId, secretAccessKey, endpoint, options });
  let attempt = 0;
  while (true) {
    try {
      execFileSync("curl", command, { stdio: "pipe", encoding: "utf8" });
      return;
    } catch (error) {
      attempt += 1;
      if (attempt > retryCount || !isRetryableS3Error(error)) {
        throw error;
      }
      console.error(`[knowledge-content] retrying remote R2 s3 put attempt=${attempt} key=${key}`);
      sleepMs(Math.min(2000, attempt * 400));
    }
  }
}

async function runS3PutWithRetryAsync({ bucket, key, file, encoding, retryCount, accessKeyId, secretAccessKey, endpoint, options }) {
  const command = s3PutCommand({ bucket, key, file, encoding, accessKeyId, secretAccessKey, endpoint, options });
  let attempt = 0;
  while (true) {
    try {
      await execFileAsync("curl", command, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return;
    } catch (error) {
      attempt += 1;
      if (attempt > retryCount || !isRetryableS3Error(error)) {
        throw error;
      }
      console.error(`[knowledge-content] retrying remote R2 s3 put attempt=${attempt} key=${key}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, attempt * 400)));
    }
  }
}

function stripPayload(value) {
  const { payload, ...rest } = value;
  return {
    ...rest,
    payloadBase64: payload ? Buffer.from(payload).toString("base64") : "",
  };
}

function writeLocalContentFile({ options, key, payload }) {
  const relativePath = contentRelativePath(key);
  const file = join(options.localContentDir, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, payload);
}

function knowledgeContentKey(docId, sha256, encoding) {
  const idHash = createHash("sha256").update(text(docId) || sha256).digest("hex");
  const extension = encoding === "br" ? "md.br" : "md";
  return `knowledge-content/${idHash.slice(0, 2)}/${idHash}-${sha256.slice(0, 12)}.${extension}`;
}

function contentRelativePath(key) {
  const normalized = text(key).replace(/^\/+|\/+$/g, "");
  if (!normalized.startsWith("knowledge-content/")) {
    throw new Error(`unsupported content key: ${key}`);
  }
  const relativePath = normalized.slice("knowledge-content/".length);
  if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe content key: ${key}`);
  }
  return relativePath;
}

function joinPublicUrl(baseUrl, key) {
  const base = text(baseUrl).replace(/\/+$/, "");
  if (!base) {
    return "";
  }
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function emptyContent() {
  return {
    contentKey: "",
    contentUrl: "",
    contentType: defaultContentType,
    contentEncoding: "identity",
    contentBytes: 0,
    contentSha256: "",
    contentPreview: "",
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}
