#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { executeLocalD1Sql } from './lib/local-d1-sqlite.mjs'

const workerPort = String(process.env.PORT || '8000')
const httpProxyUrl = process.env.HTTP_PROXY_URL || 'http://127.0.0.1:7890'
const httpProxyRelayUrl = process.env.HTTP_PROXY_RELAY_URL || `${httpProxyUrl.replace(/\/+$/, '')}/fetch`
const httpProxyDomains = process.env.HTTP_PROXY_DOMAINS || 'yahoo.com'
const httpDomainConcurrency = process.env.HTTP_DOMAIN_CONCURRENCY || '5'
const httpRequestTimeoutMs = process.env.HTTP_REQUEST_TIMEOUT_MS || '10000'
const llmDailyLimit = process.env.LLM_DAILY_LIMIT || '1000000'
const knowledgeReportConverterUrl = process.env.KNOWLEDGE_REPORT_CONVERTER_URL || 'http://127.0.0.1:8788/__convert-report'
const passthroughVarNames = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'LLM_API_KEY',
  'LLM_BASE_URL',
]

const localLlmApiKey = await resolveLocalLlmApiKey()
const localLlmEnvFile = localLlmApiKey ? await createLocalLlmEnvFile(localLlmApiKey) : null
clearUnfinishedResearchJobs()
const workerEnv = {
  ...process.env,
  ...(localLlmApiKey ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY || localLlmApiKey } : {}),
  HTTP_PROXY_URL: httpProxyUrl,
  HTTP_PROXY_RELAY_URL: httpProxyRelayUrl,
  HTTP_PROXY_DOMAINS: httpProxyDomains,
  HTTP_DOMAIN_CONCURRENCY: httpDomainConcurrency,
  HTTP_REQUEST_TIMEOUT_MS: httpRequestTimeoutMs,
}

const workerVars = [
  '--var',
  `HTTP_PROXY_URL:${httpProxyUrl}`,
  '--var',
  `HTTP_PROXY_RELAY_URL:${httpProxyRelayUrl}`,
  '--var',
  `HTTP_PROXY_DOMAINS:${httpProxyDomains}`,
  '--var',
  `HTTP_DOMAIN_CONCURRENCY:${httpDomainConcurrency}`,
  '--var',
  `HTTP_REQUEST_TIMEOUT_MS:${httpRequestTimeoutMs}`,
  '--var',
  `LLM_DAILY_LIMIT:${llmDailyLimit}`,
  '--var',
  `KNOWLEDGE_REPORT_CONVERTER_URL:${knowledgeReportConverterUrl}`,
  '--var',
  'LLM_RUNTIME:local',
]

for (const key of passthroughVarNames) {
  // Credentials stay in the local child environment.  Passing them as a
  // `--var` would expose them through the command line and Wrangler logs.
  if (key === 'OPENAI_API_KEY' || key === 'LLM_API_KEY') continue
  const value = process.env[key]
  if (typeof value === 'string' && value.trim()) {
    workerVars.push('--var', `${key}:${value.trim()}`)
  }
}

/** Development-only convenience: the local Worker receives the same remote
 * model credential already used by the repository's local research scripts.
 * It never writes the credential to .dev.vars, D1, logs, or production config. */
async function resolveLocalLlmApiKey() {
  if (typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.trim()) return process.env.OPENAI_API_KEY.trim()
  if (typeof process.env.LLM_API_KEY === 'string' && process.env.LLM_API_KEY.trim()) return process.env.LLM_API_KEY.trim()
  try {
    const credentials = JSON.parse(await readFile(`${homedir()}/.codex/auth.json`, 'utf8'))
    const value = credentials?.OPENAI_API_KEY
    return typeof value === 'string' && value.trim() ? value.trim() : ''
  } catch {
    return ''
  }
}

async function createLocalLlmEnvFile(apiKey) {
  const directory = await mkdtemp(join(tmpdir(), 'stock-info-llm-'))
  const file = join(directory, 'worker.env')
  await writeFile(file, `OPENAI_API_KEY=${apiKey}\n`, { encoding: 'utf8', mode: 0o600 })
  return file
}

function clearUnfinishedResearchJobs() {
  const now = Date.now()
  try {
    const databaseFile = executeLocalD1Sql(`
      update research_web_search_package_jobs
      set status='failed',
          last_error='local Worker restarted before this Web Search task finished; retry the package',
          completed_at=${now},
          updated_at=${now}
      where status in ('queued', 'running');
    `, { requiredTable: 'research_web_search_package_jobs' })
    // WebQA-backed report jobs are intentionally not touched here. Their
    // browser work is persisted by input-gateway and must recover the same
    // provider session after a Worker restart rather than being failed or
    // replayed. Web Search package jobs have their own retry contract.
    console.log(`Cleared unfinished local Web Search jobs: ${databaseFile}`)
  } catch (error) {
    if (/local Wrangler D1 state directory does not exist|expected one local D1 database/.test(String(error))) return
    throw error
  }
}

let workerProcess = null
let cronProcess = null
let webSearchRunnerProcess = null
let operatingAnalysisRunnerProcess = null
let informationProcessingRunnerProcess = null
let shuttingDown = false

try {
  workerProcess = spawn('npx', [
    'wrangler',
    'dev',
    '--local',
    '--port',
    workerPort,
    '--show-interactive-dev-session=false',
    ...(localLlmEnvFile ? ['--env-file', localLlmEnvFile] : []),
    ...workerVars,
  ], {
    env: workerEnv,
    stdio: 'inherit',
  })
  cronProcess = spawn(process.execPath, [
    fileURLToPath(new URL('./local-cron-runner.mjs', import.meta.url)),
    '--base-url',
    `http://127.0.0.1:${workerPort}`,
    '--config',
    fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
  ], {
    env: workerEnv,
    stdio: 'inherit',
  })
  webSearchRunnerProcess = spawn(process.execPath, [
    fileURLToPath(new URL('./research-web-search-package-runner.mjs', import.meta.url)),
  ], {
    env: { ...workerEnv, WEB_SEARCH_PACKAGE_RUNNER_BASE_URL: `http://127.0.0.1:${workerPort}` },
    stdio: 'inherit',
  })
  operatingAnalysisRunnerProcess = spawn(process.execPath, [
    fileURLToPath(new URL('./research-operating-analysis-runner.mjs', import.meta.url)),
  ], {
    env: { ...workerEnv, OPERATING_ANALYSIS_RUNNER_BASE_URL: `http://127.0.0.1:${workerPort}` },
    stdio: 'inherit',
  })
  informationProcessingRunnerProcess = spawn(process.execPath, [
    fileURLToPath(new URL('./information-processing-runner.mjs', import.meta.url)),
  ], {
    env: { ...workerEnv, INFORMATION_PROCESSING_RUNNER_BASE_URL: `http://127.0.0.1:${workerPort}` },
    stdio: 'inherit',
  })
} catch (error) {
  shuttingDown = true
  workerProcess?.kill('SIGTERM')
  cronProcess?.kill('SIGTERM')
  webSearchRunnerProcess?.kill('SIGTERM')
  operatingAnalysisRunnerProcess?.kill('SIGTERM')
  informationProcessingRunnerProcess?.kill('SIGTERM')
  throw error
}

// Wrangler reads --env-file during startup.  The private temporary file is
// removed shortly afterwards; credentials never appear in command arguments,
// logs, repository files, D1, or production configuration.
if (localLlmEnvFile) {
  setTimeout(() => { void rm(localLlmEnvFile, { force: true }) }, 5_000).unref()
}

const terminate = () => {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  workerProcess?.kill('SIGTERM')
  cronProcess?.kill('SIGTERM')
  webSearchRunnerProcess?.kill('SIGTERM')
  operatingAnalysisRunnerProcess?.kill('SIGTERM')
  informationProcessingRunnerProcess?.kill('SIGTERM')
}

process.on('SIGINT', terminate)
process.on('SIGTERM', terminate)

const processExitCode = await new Promise((resolve) => {
  const handleExit = (name) => (code, signal) => {
    if (!shuttingDown && (signal || code !== 0)) {
      console.error(`${name} exited unexpectedly`, { code, signal })
    }
    terminate()
    if (signal) {
      resolve(1)
      return
    }
    resolve(code ?? 0)
  }
  workerProcess.on('exit', handleExit('Local Worker'))
  cronProcess.on('exit', handleExit('Local cron runner'))
  webSearchRunnerProcess.on('exit', handleExit('Local Web Search package runner'))
  operatingAnalysisRunnerProcess.on('exit', handleExit('Local operating analysis runner'))
  informationProcessingRunnerProcess.on('exit', handleExit('Local information processing runner'))
})

process.exit(processExitCode)
