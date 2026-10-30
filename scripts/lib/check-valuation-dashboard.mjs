import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Tests only: execute the native implementation on isolated temporary SQLite.
// One process owns the Cargo gate; all basic check adapters share this receipt.
let nativeReceipt;
export function ensureNativeBasicRegressions() {
  if (nativeReceipt) return nativeReceipt;
  const suites = ['dashboard_cache', 'observation', 'observation_integration',
    'portfolio_contract', 'dashboard_domain_opportunity', 'retired_baseline_contract'];
  const args = ['test', '--locked', '--manifest-path', 'backend/Cargo.toml'];
  for (const suite of suites) args.push('--test', suite);
  const result = spawnSync('cargo', args, {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  const log = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`Native basic regressions failed (exit ${result.status}):\n${log.slice(-12000)}`, { cause: result.error });
  }
  const receipts = [...log.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (receipts.length !== suites.length || receipts.some(r => +r[1] === 0 || +r[2] || +r[3])) {
    throw new Error(`Incomplete native basic coverage receipts:\n${log.slice(-12000)}`);
  }
  nativeReceipt = { runtime: 'rust', suites, tests: receipts.reduce((n, r) => n + +r[1], 0) };
  return nativeReceipt;
}

export async function checkValuationDashboard() {
  const native = ensureNativeBasicRegressions();
  return { valuationCache: 'passed', native,
    checks: ['spot-quote-validation', 'read-only', 'single-flight', 'global-limit',
      'fresh-reuse', 'batch-cache', 'revision', 'fencing', 'lease-recovery',
      'research-version-invalidation'] };
}
