#!/usr/bin/env node

const baseUrl = String(process.env.STOCK_INFO_LOCAL_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const args = process.argv.slice(2);
const deep = args.includes("--deep");
const codes = args.filter((value) => value !== "--deep").map((value) => value.trim().toUpperCase()).filter(Boolean);
if (!codes.length) throw new Error("usage: npm run research:bootstrap-companies -- [--deep] 600519.SH 601088.SH 00700.HK AAPL.US");

const results = await Promise.all(codes.map(async (code) => {
  const response = await fetch(`${baseUrl}/api/research/company/${encodeURIComponent(code)}/bootstrap`, { method: "POST" });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(`${code}: ${body?.msg || response.status}`);
  if (!deep) return body.data;
  const disclosures = await request(`/research/company/${encodeURIComponent(code)}/statutory-disclosures`);
  const selected = selectDisclosureDocuments(disclosures.items || []);
  const processed = [];
  for (const document of selected) {
    const id = encodeURIComponent(document.documentId);
    const imported = await request(`/research/company/${encodeURIComponent(code)}/statutory-disclosures/${id}/import-local`, { method: "POST" });
    const insights = await request(`/research/company/${encodeURIComponent(code)}/statutory-disclosures/${id}/auto-insights`, { method: "POST" });
    processed.push({ documentId: document.documentId, title: document.title, publishedAt: document.publishedAt, imported, insights });
  }
  return { ...body.data, deepProcessing: { selected: selected.length, processed } };
}));
console.log(JSON.stringify({ baseUrl, deep, results }, null, 2));

async function request(path, init) {
  const response = await fetch(`${baseUrl}/api${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(`${path}: ${body?.msg || response.status}`);
  return body.data;
}

function selectDisclosureDocuments(items) {
  const sorted = [...items].sort((left, right) => String(right.publishedAt || "").localeCompare(String(left.publishedAt || "")));
  const isReport = (item) => !/(?:摘要|summary|英文版|披露的提示性公告|预约披露|变更.*报告.*披露|关于.*报告.*披露)/i.test(`${item.title || ""} ${item.documentType || ""}`);
  const annual = sorted.find((item) => isReport(item) && /(?:年度报告|annual report|\b10-k\b)/i.test(`${item.title || ""} ${item.documentType || ""}`));
  const periodic = sorted.find((item) => isReport(item) && /(?:第[一二三四]季度报告|[一二三四]季度报告|[一二三四]季(?:度)?报告|半年度报告|interim|\b10-q\b)/i.test(`${item.title || ""} ${item.documentType || ""}`) && item.documentId !== annual?.documentId);
  return [annual, periodic].filter(Boolean);
}
