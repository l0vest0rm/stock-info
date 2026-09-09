import { Context, Hono } from "hono";
import { fetchEastmoneyCompanyNotices } from "../../../adapters/eastmoney";
import {
  fetchCninfoCompanyNotices,
  fetchCninfoCompanyResearch,
  supportsCninfoCompanyNotices,
  supportsCninfoCompanyResearch,
} from "../../../adapters/cninfo";
import { normalizeSecurityCode } from "../../../shared/codes";
import { fail, ok, requireQuery } from "../../../shared/http";
import { type AppEnv } from "../../../types";
import { fetchCompanyOverview } from "../application/company-overview";
import {
  getCompanyReportsWithProgress,
  loadCompanyReportDiscoverySnapshot,
  enqueueCompanyReportDiscovery,
} from "../application/company-reports";
import { isCnCode } from "../domain/report-identity";
import { aggregateForecastsForCode } from "../domain/report-valuation";

export const companyRoutes = new Hono<AppEnv>();

companyRoutes.get("/company/overview", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const data = await fetchCompanyOverview(c.env, code);
  return ok(c, data);
});

companyRoutes.get("/company/info", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const overview = await fetchCompanyOverview(c.env, code);
  return ok(c, {
    code: overview.code,
    secCode: overview.code.split(".")[0],
    shortName: overview.name,
    name: overview.name,
    market: overview.market,
    type: overview.type,
    latestPrice: overview.latestPrice,
    marketCapYi: overview.marketCapYi,
    peTtm: overview.peTtm,
    pb: overview.pb,
  });
});

companyRoutes.get("/company/notices", async (c) => {
  const code = noticeCode(c);
  if (!code) {
    return fail(c, 400, "Missing code parameter");
  }
  const page = Number(c.req.query("page") ?? "1") || 1;
  const pageSize = Number(c.req.query("pageSize") ?? "20") || 20;
  const category = c.req.query("category")?.trim() ?? "";
  const contentKind = c.req.query("contentKind")?.trim() || "notice";
  if (contentKind !== "notice" && contentKind !== "research") {
    return fail(c, 400, "contentKind must be notice or research");
  }
  const data = contentKind === "research"
    ? (supportsCninfoCompanyResearch(code) ? await fetchCninfoCompanyResearch(c.env.DB, code, page, pageSize) : [])
    : (supportsCninfoCompanyNotices(code)
      ? await fetchCninfoCompanyNotices(c.env.DB, code, page, pageSize, category)
      : await fetchEastmoneyCompanyNotices(c.env.DB, code, page, pageSize));
  return ok(
    c,
    data.map((item) => ({
      art_code: item.artCode,
      title: item.title,
      notice_date: item.noticeDate,
      columns: [{ column_name: item.noticeType }],
      pdf_url: item.pdfUrl,
      content_kind: contentKind,
    }))
  );
});

companyRoutes.get("/company/reports", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const page = positivePage(c.req.query("page"));
  const items = await getCompanyReportsWithProgress(c.env, code, page, () => undefined);
  return ok(c, items);
});

// The discovery control is intentionally advertised only by the local LLM
// runtime.  The page uses this read-only capability/status projection instead
// of inferring local mode from its hostname or build configuration.
companyRoutes.get("/company/reports/discovery-capability", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") {
    return fail(c, 404, "company report discovery is only available in local LLM runtime");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const normalized = normalizeSecurityCode(code);
  if (!isCnCode(normalized)) {
    return ok(c, { enabled: false, code: normalized, task: null, lastSuccessfulCompletedAt: null });
  }
  const stored = await loadCompanyReportDiscoverySnapshot(c.env, normalized);
  return ok(c, {
    enabled: true,
    code: normalized,
    task: stored?.task ?? null,
    lastSuccessfulCompletedAt: stored?.lastSuccessfulCompletedAt ?? null,
  });
});

companyRoutes.get("/company/reports/stream", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const page = positivePage(c.req.query("page"));
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const items = await getCompanyReportsWithProgress(c.env, code, page, (event) => {
          if (event.progress) {
            controller.enqueue(
              encodeSseData({
                type: "progress",
                completed: event.progress.completed,
                total: event.progress.total,
                title: event.progress.title,
              })
            );
          }
          if (event.items) {
            controller.enqueue(encodeSseData({ type: "partial", data: event.items }));
          }
          if (event.delta) {
            controller.enqueue(encodeSseData({ type: "delta", text: event.delta }));
          }
          if (event.status === "queued") controller.enqueue(encodeSseData({ type: "queued" }));
          if (event.status === "running") controller.enqueue(encodeSseData({ type: "claimed" }));
          if (event.failures?.length) controller.enqueue(encodeSseData({ type: "forecast_failures", failures: event.failures }));
        });
        controller.enqueue(encodeSseData({ type: "result", data: items }));
      } catch (error) {
        controller.enqueue(
          encodeSseData({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          })
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
});

// Web Search report discovery is an explicit taskd submission. A normal report
// page GET/SSE remains read-only and only serves the materialized source pool.
companyRoutes.post("/company/reports/discover", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") {
    return fail(c, 404, "company report discovery is only available in local LLM runtime");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return ok(c, await enqueueCompanyReportDiscovery(c.env, code, body.reasoningEffort));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

companyRoutes.get("/report/forecast", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const items = await getCompanyReportsWithProgress(c.env, code, 1, () => undefined);
  return ok(c, aggregateForecastsForCode(code, items));
});

companyRoutes.get("/report/url", (c) => ok(c, null));

function noticeCode(c: Context<AppEnv>): string {
  const direct = c.req.query("code")?.trim();
  if (direct) {
    return direct;
  }
  const stock = c.req.query("stock")?.trim();
  const type = c.req.query("type")?.trim();
  if (!stock) {
    return "";
  }
  return type ? `${stock}.${type.toUpperCase()}` : stock;
}

function positivePage(value: string | undefined): number {
  const page = Number(value ?? "1");
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function encodeSseData(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}
