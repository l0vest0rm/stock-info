import { Hono } from "hono";
import { fetchJson, fetchText, ok } from "../shared/http";
import type { AppEnv } from "../types";

export const thirteenFRoutes = new Hono<AppEnv>();

thirteenFRoutes.get("/13f/manager/list", async (c) => {
  const html = await fetchText("https://13f.info/managers", {
    headers: { Referer: "https://13f.info/" },
  });
  const rows: unknown[][] = [["0001759760-h-h-international-investment-llc", "H&H International Investment, LLC", "段永平基金", "$14 B", 14000]];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    if (cells.length < 5) continue;
    const href = tr[1].match(/href=["']\/manager\/([^"']+)["']/i)?.[1] ?? "";
    if (!href || !cells[0]) continue;
    rows.push([href, cells[0], managerChineseName(cells[0]), cells[4], parseVolume(cells[4])]);
  }
  rows.sort((a, b) => Number(b[4] ?? 0) - Number(a[4] ?? 0));
  return ok(c, rows);
});

thirteenFRoutes.get("/13f/quarters/:id", async (c) => {
  const id = c.req.param("id");
  const html = await fetchText(`https://13f.info/manager/${encodeURIComponent(id)}`, {
    headers: { Referer: "https://13f.info/managers" },
  });
  const table = html.match(/id=["']managerFilings["'][\s\S]*?<\/table>/i)?.[0] ?? html;
  const rows: string[][] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    if (cells.length < 6) continue;
    const order = tr[1].match(/data-order=["']([^"']+)["']/i)?.[1];
    if (order) cells[5] = order;
    if (cells[4] === "13F-HR" || cells[4] === "RESTATEMENT") rows.push(cells);
  }
  return ok(c, rows);
});

thirteenFRoutes.get("/13f/position/:filingId", async (c) => {
  const filingId = c.req.param("filingId");
  const body = (await fetchJson(`https://13f.info/data/13f/${encodeURIComponent(filingId)}`, {
    headers: { Referer: "https://13f.info/" },
  })) as { data?: unknown[] };
  return ok(c, Array.isArray(body.data) ? body.data : []);
});

function strip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function managerChineseName(name: string): string {
  const map: Record<string, string> = {
    "H&H International Investment, LLC": "段永平基金",
    "Berkshire Hathaway Inc": "伯克希尔哈撒韦",
    "HHLR ADVISORS, LTD.": "高领资本",
    "GOLDMAN SACHS GROUP INC": "高盛集团",
    "Bridgewater Associates, LP": "桥水基金",
    "ARK Investment Management LLC": "方舟基金",
    "BlackRock Inc.": "贝莱德公司",
    "VANGUARD GROUP INC": "先锋集团",
    "STATE STREET CORP": "道富银行",
  };
  return map[name] ?? name;
}

function parseVolume(value: string): number {
  const unit = value.includes("T") ? 1e6 : value.includes("B") ? 1e3 : value.includes("M") ? 1 : 0;
  const num = Number(value.replace(/[$,]/g, "").replace(/[TBM].*$/i, "").trim());
  return Number.isFinite(num) ? num * unit : 0;
}
