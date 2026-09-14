/**
 * Build-time mirror of the server's APP_RUNTIME binding. The local build
 * injects `node`; deploy-cloudflare.sh builds with `cloudflare`.
 */
declare const __STOCK_INFO_APP_RUNTIME__: 'node' | 'cloudflare'

export const appRuntime = __STOCK_INFO_APP_RUNTIME__
export const isLocalDevelopmentRuntime = appRuntime === 'node'
