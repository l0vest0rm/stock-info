import { Hono } from "hono";
import { isSupportedCompanyCode, normalizeSecurityCode } from "../../../shared/codes";
import { fail, ok } from "../../../shared/http";
import type { AppEnv } from "../../../types";
import {
  enqueueResearchFinancialAnalysis,
  loadResearchFinancialAnalysis,
  resumeResearchFinancialAnalysis,
} from "../application/research-financial-analysis";
import {
  enqueueResearchInvestmentAnalysis,
  loadResearchInvestmentAnalysis,
  resumeResearchInvestmentAnalysis,
} from "../application/research-investment-analysis";
import { canWriteResearchLocally } from "../domain/research-capabilities";

/**
 * Public research API surface.
 *
 * The site currently publishes only the financial and investment analysis
 * pages. Keep their HTTP contract here; research workbench APIs belong to a
 * page before they may be exposed again.
 */
export const researchRoutes = new Hono<AppEnv>();

researchRoutes.get("/research/company/:code/investment-analysis", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await loadResearchInvestmentAnalysis(c.env, code));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

researchRoutes.get("/research/company/:code/financial-analysis", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await loadResearchFinancialAnalysis(c.env, code));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

researchRoutes.post("/research/company/:code/financial-analysis/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial analysis refresh is only available in local LLM runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return ok(c, await enqueueResearchFinancialAnalysis(c.env, code, {
      force: body.force !== false,
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
    }));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

researchRoutes.post("/research/company/:code/financial-analysis/resume", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial analysis resume is only available in local LLM runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await resumeResearchFinancialAnalysis(c.env, code));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

researchRoutes.post("/research/company/:code/investment-analysis/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "investment analysis refresh is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return ok(c, await enqueueResearchInvestmentAnalysis(c.env, code, {
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
    }));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

researchRoutes.post("/research/company/:code/investment-analysis/resume", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "investment analysis resume is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await resumeResearchInvestmentAnalysis(c.env, code));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});
