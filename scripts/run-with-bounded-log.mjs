#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0) throw new Error("usage: run-with-bounded-log.mjs --file LOG --max-bytes N --backups N -- command [args...]");
const options = parseOptions(args.slice(0, separator));
const command = args.slice(separator + 1);
if (!command.length) throw new Error("missing command after --");

const file = resolve(required(options.file, "--file"));
const maxBytes = positiveInteger(options.maxBytes, "--max-bytes");
const backups = positiveInteger(options.backups, "--backups");
mkdirSync(dirname(file), { recursive: true });
let size = existsSync(file) ? statSync(file).size : 0;

function rotate() {
  rmSync(`${file}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index -= 1) {
    if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`);
  }
  if (existsSync(file)) renameSync(file, `${file}.1`);
  size = 0;
}

function write(chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    if (size >= maxBytes) rotate();
    const length = Math.min(maxBytes - size, chunk.length - offset);
    appendFileSync(file, chunk.subarray(offset, offset + length));
    size += length;
    offset += length;
  }
}

if (size >= maxBytes) rotate();
const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", write);
child.stderr.on("data", write);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  write(Buffer.from(`${error.stack || error.message}\n`));
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name.startsWith("--")) throw new Error(`unexpected option: ${name}`);
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
