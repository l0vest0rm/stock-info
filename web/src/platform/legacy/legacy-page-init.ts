import { runPageInit } from './legacy-runtime'

export function runLegacyPageInit(page) {
  const run = () => {
    Promise.resolve(runPageInit(page)).catch((error) => {
      console.error('Failed to initialize page:', error)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}
