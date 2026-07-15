#!/usr/bin/env node

import http from 'node:http'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const host = process.env.HTTP_PROXY_RELAY_HOST || '127.0.0.1'
const port = Number(process.env.HTTP_PROXY_RELAY_PORT || '8789')
const proxyUrl = String(process.env.HTTP_PROXY_URL || '').trim()
const proxyDomains = String(process.env.HTTP_PROXY_DOMAINS || '')
  .split(/[\s,]+/)
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)

if (!proxyUrl) {
  throw new Error('HTTP_PROXY_URL is required')
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/__health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (request.method !== 'POST' || request.url !== '/fetch') {
    response.writeHead(404)
    response.end('not found')
    return
  }
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    response.writeHead(415)
    response.end('application/json required')
    return
  }

  let dispatcher
  try {
    const payload = JSON.parse(await readRequestBody(request))
    const target = new URL(String(payload.url || ''))
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`unsupported target protocol: ${target.protocol}`)
    }
    if (!proxyDomains.some((domain) => target.hostname === domain || target.hostname.endsWith(`.${domain}`))) {
      throw new Error(`target host is not allowed: ${target.hostname}`)
    }
    dispatcher = new ProxyAgent(proxyUrl)
    const upstream = await undiciFetch(target, {
      method: String(payload.method || 'GET').toUpperCase(),
      headers: normalizeHeaders(payload.headers),
      body: typeof payload.body === 'string' ? payload.body : undefined,
      dispatcher,
    })
    const body = Buffer.from(await upstream.arrayBuffer())
    response.writeHead(upstream.status, relayResponseHeaders(upstream.headers))
    response.end(body)
  } catch (error) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(error instanceof Error ? error.message : String(error))
  } finally {
    await dispatcher?.close().catch(() => {})
  }
})

server.listen(port, host, () => {
  console.log(`Local HTTP proxy relay listening on http://${host}:${port}`)
})

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('relay request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
}

function relayResponseHeaders(headers) {
  const result = {}
  for (const [key, value] of headers.entries()) {
    if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') {
      continue
    }
    result[key] = value
  }
  return result
}
