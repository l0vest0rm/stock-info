#!/usr/bin/env node

import { spawn } from 'node:child_process'
import process from 'node:process'

const workerPort = String(process.env.PORT || '8000')
const httpProxyUrl = process.env.HTTP_PROXY_URL || 'http://127.0.0.1:7890'
const httpProxyDomains = process.env.HTTP_PROXY_DOMAINS || 'yahoo.com'
const httpDomainConcurrency = process.env.HTTP_DOMAIN_CONCURRENCY || '3'
const llmDailyLimit = process.env.LLM_DAILY_LIMIT || '1000000'
const passthroughVarNames = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'VOLC_ARK_API_KEY',
  'VOLC_ARK_BASE_URL',
  'LLM_API_KEY',
  'LLM_BASE_URL',
]

const workerEnv = {
  ...process.env,
  HTTP_PROXY_URL: httpProxyUrl,
  HTTP_PROXY_DOMAINS: httpProxyDomains,
  HTTP_DOMAIN_CONCURRENCY: httpDomainConcurrency,
}

const workerVars = [
  '--var',
  `HTTP_PROXY_URL:${httpProxyUrl}`,
  '--var',
  `HTTP_PROXY_DOMAINS:${httpProxyDomains}`,
  '--var',
  `HTTP_DOMAIN_CONCURRENCY:${httpDomainConcurrency}`,
  '--var',
  `LLM_DAILY_LIMIT:${llmDailyLimit}`,
]

for (const key of passthroughVarNames) {
  const value = process.env[key]
  if (typeof value === 'string' && value.trim()) {
    workerVars.push('--var', `${key}:${value.trim()}`)
  }
}

let workerProcess = null
let shuttingDown = false

try {
  workerProcess = spawn('npx', [
    'wrangler',
    'dev',
    '--local',
    '--port',
    workerPort,
    '--show-interactive-dev-session=false',
    ...workerVars,
  ], {
    env: workerEnv,
    stdio: 'inherit',
  })
} catch (error) {
  shuttingDown = true
  throw error
}

const terminate = () => {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  workerProcess?.kill('SIGTERM')
}

process.on('SIGINT', terminate)
process.on('SIGTERM', terminate)

const workerExitCode = await new Promise((resolve) => {
  workerProcess.on('exit', (code, signal) => {
    terminate()
    if (signal) {
      resolve(1)
      return
    }
    resolve(code ?? 0)
  })
})

process.exit(workerExitCode)
