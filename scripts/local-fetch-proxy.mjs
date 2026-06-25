#!/usr/bin/env node

import http from 'node:http'
import https from 'node:https'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { ProxyAgent, fetch } from 'undici'

const port = Number(process.env.LOCAL_FETCH_PROXY_PORT || '8791')
const host = process.env.LOCAL_FETCH_PROXY_HOST || '127.0.0.1'
const proxyEnabled = isTruthy(process.env.PROXY_ENABLED)
const upstreamProxy = normalizeProxy(process.env.PROXY_URL || '')
const proxyDomains = parseDomains(process.env.PROXY_DOMAINS || '')
const dispatcher = upstreamProxy && !upstreamProxy.startsWith('socks')
  ? new ProxyAgent(upstreamProxy)
  : undefined
const socksAgent = upstreamProxy?.startsWith('socks')
  ? new SocksProxyAgent(upstreamProxy)
  : undefined

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    writeJson(res, 200, {
      ok: true,
      proxyEnabled,
      proxyUrl: upstreamProxy,
      proxyDomains,
    })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method not allowed' })
    return
  }

  try {
    const payload = JSON.parse(await readBody(req))
    const url = new URL(String(payload.url || ''))
    if (url.protocol !== 'https:') {
      writeJson(res, 400, { error: `unsupported proxy target protocol: ${url.protocol}` })
      return
    }
    const useUpstreamProxy = proxyEnabled && !!upstreamProxy && shouldUseUpstreamProxy(url)
    console.log(`${new Date().toISOString()} ${payload.method || 'GET'} ${url.hostname}${url.pathname} proxy=${useUpstreamProxy ? upstreamProxy : 'DIRECT'}`)
    const response = useUpstreamProxy && socksAgent
      ? await fetchViaHttpsAgent(url, {
        method: payload.method || 'GET',
        headers: payload.headers || {},
        body: payload.body,
      }, socksAgent)
      : await fetch(url, {
        method: payload.method || 'GET',
        headers: payload.headers || {},
        body: payload.body,
        dispatcher: useUpstreamProxy ? dispatcher : undefined,
      }).then(async (response) => ({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bodyText: await response.text(),
      }))
    writeJson(res, 200, {
      status: response.status,
      headers: response.headers,
      bodyText: response.bodyText,
      usedProxy: useUpstreamProxy,
      proxyUrl: useUpstreamProxy ? upstreamProxy : '',
      targetHost: url.hostname,
    })
  } catch (error) {
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, host, () => {
  console.log(`Local fetch proxy ready: http://${host}:${port}`)
  console.log(`Proxy enabled: ${proxyEnabled}`)
  console.log(`Proxy URL: ${upstreamProxy || 'DIRECT'}`)
  console.log(`Proxy domains: ${proxyDomains.join(',') || '(none)'}`)
})

function shouldUseUpstreamProxy(url) {
  const host = url.hostname.toLowerCase()
  return proxyDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

function parseDomains(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => normalizeDomain(item))
    .filter(Boolean)
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^\./, '')
    .replace(/\/$/, '')
}

function isTruthy(value) {
  const text = String(value || '').trim().toLowerCase()
  return text === '1' || text === 'true' || text === 'yes' || text === 'on'
}

function normalizeProxy(value) {
  const text = String(value || '').trim()
  if (!text || text.toUpperCase() === 'DIRECT') {
    return ''
  }
  const proxyMatch = text.match(/^PROXY\s+(.+)$/i)
  if (proxyMatch) {
    return `http://${proxyMatch[1].trim()}`
  }
  const socksMatch = text.match(/^SOCKS(?:5)?\s+(.+)$/i)
  if (socksMatch) {
    return `socks5://${socksMatch[1].trim()}`
  }
  if (/^https?:\/\//i.test(text) || /^socks5?:\/\//i.test(text)) {
    return text
  }
  return `http://${text}`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 2 * 1024 * 1024) {
        req.destroy()
        reject(new Error('request body too large'))
      }
    })
    req.on('end', () => resolve(body || '{}'))
    req.on('error', reject)
  })
}

function fetchViaHttpsAgent(url, options, agent) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      agent,
    }, (res) => {
      let bodyText = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        bodyText += chunk
      })
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          bodyText,
        })
      })
    })
    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}
