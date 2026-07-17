#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Cron } from 'croner'
import { parse, printParseErrorCode } from 'jsonc-parser'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000'
const DEFAULT_CONFIG_PATH = 'wrangler.jsonc'

export function parseCronExpressions(source, configPath = DEFAULT_CONFIG_PATH) {
  const errors = []
  const config = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ')
    throw new Error(`Invalid JSONC in ${configPath}: ${details}`)
  }
  const crons = config?.triggers?.crons
  if (!Array.isArray(crons) || crons.length === 0) {
    throw new Error(`No triggers.crons entries found in ${configPath}`)
  }
  if (!crons.every((value) => typeof value === 'string' && value.trim())) {
    throw new Error(`Every triggers.crons entry in ${configPath} must be a non-empty string`)
  }
  const expressions = crons.map((value) => value.trim())
  return [...new Set(expressions)]
}

export async function loadCronExpressions(configPath = DEFAULT_CONFIG_PATH) {
  return parseCronExpressions(await readFile(configPath, 'utf8'), configPath)
}

export function scheduledUrl(baseUrl, cron, scheduledTime = Date.now()) {
  const url = new URL('/cdn-cgi/handler/scheduled', baseUrl)
  url.searchParams.set('cron', cron)
  url.searchParams.set('time', String(scheduledTime))
  return url
}

export async function dispatchScheduled({
  baseUrl,
  cron,
  scheduledTime = Date.now(),
  fetchImpl = fetch,
}) {
  const url = scheduledUrl(baseUrl, cron, scheduledTime)
  const startedAt = Date.now()
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`Scheduled request failed with HTTP ${response.status}: ${body.slice(0, 500)}`)
  }
  return { durationMs: Date.now() - startedAt, status: response.status, body }
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.LOCAL_CRON_BASE_URL || DEFAULT_BASE_URL,
    configPath: process.env.LOCAL_CRON_CONFIG || DEFAULT_CONFIG_PATH,
    once: false,
    cron: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--once') {
      options.once = true
      continue
    }
    if (arg === '--base-url' || arg === '--config' || arg === '--cron') {
      const value = argv[index + 1]
      if (!value) throw new Error(`Missing value for ${arg}`)
      index += 1
      if (arg === '--base-url') options.baseUrl = value
      if (arg === '--config') options.configPath = value
      if (arg === '--cron') options.cron = value
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function log(message) {
  console.log(`[local-cron ${new Date().toISOString()}] ${message}`)
}

async function run() {
  const options = parseArgs(process.argv.slice(2))
  const configuredCrons = await loadCronExpressions(options.configPath)
  const crons = options.cron
    ? configuredCrons.filter((expression) => expression === options.cron)
    : configuredCrons
  if (crons.length === 0) {
    throw new Error(`Cron expression is not configured in ${options.configPath}: ${options.cron}`)
  }

  const trigger = async (cron) => {
    log(`triggering cron=${JSON.stringify(cron)}`)
    const result = await dispatchScheduled({ baseUrl: options.baseUrl, cron })
    log(`completed cron=${JSON.stringify(cron)} status=${result.status} duration_ms=${result.durationMs}`)
  }

  if (options.once) {
    await Promise.all(crons.map(trigger))
    return
  }

  const activeRuns = new Set()
  const jobs = crons.map((cron) => {
    const job = new Cron(cron, {
      timezone: 'UTC',
      catch: (error) => console.error(`[local-cron ${new Date().toISOString()}] cron=${JSON.stringify(cron)} failed`, error),
    }, () => {
      const run = trigger(cron).finally(() => activeRuns.delete(run))
      activeRuns.add(run)
      return run
    })
    log(`scheduled cron=${JSON.stringify(cron)} timezone=UTC next=${job.nextRun()?.toISOString() ?? 'none'}`)
    return job
  })

  const shutdown = async (signal) => {
    log(`received ${signal}; stopping scheduler`)
    for (const job of jobs) job.stop()
    await Promise.allSettled(activeRuns)
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(`[local-cron ${new Date().toISOString()}] fatal`, error)
    process.exitCode = 1
  })
}
