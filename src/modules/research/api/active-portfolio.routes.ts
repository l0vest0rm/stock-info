import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../../types';
import { ok, fail } from '../../../shared/http';
import { readValuationDashboard } from '../application/valuation-screen-cache';
import { readPortfolio, writePortfolio, portfolioVersions, PortfolioConflict } from '../application/active-portfolio';

export const activePortfolioRoutes = new Hono<AppEnv>();
// Both reads and writes are private; never depend on public parent CORS rules.
activePortfolioRoutes.use('/research/portfolio/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const url = new URL(c.req.url), origin = c.req.header('Origin');
  if (c.env.APP_RUNTIME !== 'node' || c.env.LLM_RUNTIME !== 'local') return fail(c, 404, '私有组合仅在本地Node工作区开放');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || origin && origin !== url.origin || c.req.header('Sec-Fetch-Site') === 'cross-site') return fail(c, 403, '仅允许本机同源组合访问');
  await next();
});
activePortfolioRoutes.use('/research/portfolio/*', bodyLimit({ maxSize: 150_000, onError: c => fail(c, 413, '组合记录超过150KB') }));
activePortfolioRoutes.get('/research/portfolio/workspace', async c => ok(c, await readPortfolio(c.env.DB, await readValuationDashboard(c.env))));
activePortfolioRoutes.get('/research/portfolio/history/:version', async c => {
  const record = (await portfolioVersions(c.env.DB)).find(v => v.version === Number(c.req.param('version')));
  return record ? ok(c, record) : fail(c, 404, '版本不在最近100条可读取窗口');
});
activePortfolioRoutes.post('/research/portfolio/workspace', async c => {
  if (!c.req.header('Content-Type')?.startsWith('application/json')) return fail(c, 415, '仅接受application/json');
  try {
    const body = await c.req.json();
    if (!body || Object.keys(body).some(k => !['expectedVersion', 'command'].includes(k))) return fail(c, 400, '请求含额外字段');
    await writePortfolio(c.env.DB, body.expectedVersion, body.command, await readValuationDashboard(c.env));
    return ok(c, await readPortfolio(c.env.DB, await readValuationDashboard(c.env)));
  } catch (error) { return fail(c, error instanceof PortfolioConflict ? 409 : 400, error instanceof Error ? error.message : '组合保存失败'); }
});
