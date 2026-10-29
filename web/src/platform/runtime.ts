/** Build-time mirror of the native local server runtime. */
declare const __STOCK_INFO_APP_RUNTIME__: 'rust'

export const appRuntime = __STOCK_INFO_APP_RUNTIME__
export const isLocalDevelopmentRuntime = appRuntime === 'rust'
