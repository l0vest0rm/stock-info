import { Hono } from "hono";
import { cachedFetchText, ok, parseJsonOrJsonp } from "../../../shared/http";
import type { AppEnv } from "../../../types";

export const marketRoutes = new Hono<AppEnv>();

marketRoutes.get("/companies/filter", async (c) => {
  const url = new URL("https://data.eastmoney.com/dataapi/xuangu/list");
  copyQuery(c.req.query(), url, {
    source: "SELECT_SECURITIES",
    client: "WEB",
  });
  return ok(c, ((await fetchJson(c.env.DB, url, "https://data.eastmoney.com/xuangu/", 60 * 60 * 1000)) as any).result ?? {});
});

marketRoutes.get("/companies/change", async (c) => {
  const ts = Date.now();
  const url = new URL("https://push2.eastmoney.com/webguest/api/qt/clist/get");
  copyQuery(c.req.query(), url, {
    timil: "1",
    cb: `jQuery3710_${ts}`,
    fid: "f184",
    po: "1",
    pz: "50",
    pn: "1",
    np: "1",
    fltt: "1",
    invt: "2",
    dect: "1",
    fields: "f2,f3,f12,f13,f14,f62,f184,f225,f165,f263,f109,f175,f264,f160,f100,f124,f265,f1",
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
    wbp2u: "|0|0|0|web",
    fs: "m:0+t:6+f:!2,m:0+t:13+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:7+f:!2,m:1+t:3+f:!2",
    _: String(ts),
  });
  return ok(c, ((await fetchJson(c.env.DB, url, "https://quote.eastmoney.com/", 60 * 1000)) as any).data ?? {});
});

marketRoutes.get("/sector/flow", async (c) => {
  const ts = Date.now();
  const url = new URL("https://push2.eastmoney.com/webguest/api/qt/clist/get");
  copyQuery(c.req.query(), url, {
    timil: "1",
    cb: `jQuery3710_${ts}`,
    fid: "f62",
    po: "1",
    pz: "50",
    pn: "1",
    np: "1",
    fltt: "1",
    invt: "2",
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
    dect: "1",
    wbp2u: "|0|0|0|web",
    fs: "m:90+s:4",
    fields: "f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205,f124,f1,f13",
    _: String(ts),
  });
  return ok(c, ((await fetchJson(c.env.DB, url, "https://quote.eastmoney.com/", 60 * 1000)) as any).data ?? {});
});

marketRoutes.get("/companies/holding/rank", async (c) => {
  const query = c.req.query();
  const url = new URL("https://data.eastmoney.com/dataapi/zlsj/list");
  copyQuery(query, url, {
    date: query.date ?? "",
    type: query.type ?? "1",
    zjc: "0",
    sortField: query.rank ?? "HOULD_NUM",
    sortDirec: "1",
    pageNum: query.page ?? "1",
    pageSize: "50",
    p: query.page ?? "1",
    pageNo: query.page ?? "1",
    pageNumber: query.page ?? "1",
  });
  const body = await fetchJson(c.env.DB, url, "https://data.eastmoney.com/zlsj/", 24 * 60 * 60 * 1000);
  return ok(c, Array.isArray(body) ? body : (body as any).data ?? []);
});

marketRoutes.get("/companies/report/cnt", (c) => ok(c, {}));
marketRoutes.get("/index/positionDates", (c) => ok(c, []));
marketRoutes.get("/index/position", (c) => ok(c, []));

async function fetchJson(db: D1Database, url: URL, referer: string, ttlMs: number): Promise<unknown> {
  const text = await cachedFetchText(
    db,
    url.toString(),
    {
      headers: {
        Accept: "*/*",
        Referer: referer,
      },
    },
    ttlMs
  );
  return parseJsonOrJsonp(text);
}

function copyQuery(query: Record<string, string>, url: URL, defaults: Record<string, string>): void {
  for (const [key, value] of Object.entries(defaults)) {
    url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
}
