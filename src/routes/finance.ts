import { Hono } from "hono";
import { loadFinancialStatements, parseStatementType } from "../services/finance";
import { fail, ok, requireQuery } from "../shared/http";
import type { AppEnv } from "../types";

export const financeRoutes = new Hono<AppEnv>();

financeRoutes.get("/finance/:statementType", async (c) => {
  const statementType = parseStatementType(c.req.param("statementType"));
  if (!statementType) {
    return fail(c, 404, "unsupported finance statement type");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const data = await loadFinancialStatements(c.env.DB, code, statementType);
  return ok(c, data);
});
