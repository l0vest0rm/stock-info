#!/usr/bin/env node
/**
 * Does the 8–18x band predict anything? (P3-4)
 *
 * The band has been in use for months and its own justification was never tested
 * forward.  P4 measured that the band covers little of each archetype's history,
 * which is a statement about *where prices sat*, not about whether buying inside
 * it pays.  Those are different questions, and only the second one decides whether
 * the band belongs in a screening rule.
 *
 * The test is deliberately blunt:
 *
 *   for every trading day with a usable multiple,
 *   record whether PE was inside the band, and what the next 1/2/3 years returned.
 *
 * Then compare forward returns inside against outside.  If a band cannot separate
 * the two, it is not a screening rule — it is a constant with a comfortable shape.
 *
 * Five things make this honest, and the first four were each a defect found while
 * building it:
 *
 *   1. **Point-in-time earnings.**  Xueqiu's historical `peTtm` carries a ~30-day
 *      to ~3-month look-ahead (寒武纪 switched to Q1 earnings 30 days early), which
 *      would leak future profit into the "cheap" label.  PE is rebuilt from daily
 *      market cap and rows whose NOTICE_DATE had passed.
 *   2. **Backward-adjusted prices.**  `fq=hfq` is mandatory.  The raw quoted price
 *      is not a lower estimate of a return, it is a different quantity: 格力 closed
 *      at 35.80 in 2019-01 unadjusted and 5351.35 adjusted, a 149x gap that is
 *      entirely dividends and splits.
 *   3. **The production rule, not the textbook band.**  The screen never tests the
 *      bottom of the band.  It requires `marketCap ≤ impliedHigh × 0.8`, i.e.
 *      PE ≤ 18 × 0.8 = 14.4x; the 8x floor is defined and never read.  So the band
 *      tested here is a *ceiling* (`--high`), and the 8x version is kept only as a
 *      labelled alternative that tells you what the floor would have done.
 *   4. **Medians, not means.**  A single ten-bagger moves a pooled mean by more
 *      than the entire effect being measured, and the mean of 3-year returns
 *      reached +99.6% inside the band while the median was +25.3%.  Medians are
 *      the headline; every mean is still printed so the gap stays visible.
 *   5. **Company-level votes, not day-level pooling.**  Being inside 8–18x is
 *      largely a property of the archetype: banks and cyclicals sit there, growth
 *      manufacturing never does.  Pooling days therefore compares *industries*
 *      while claiming to compare *valuations*.  The headline test is one vote per
 *      company — did its cheapest forward return beat its own median? — which is
 *      the only comparison the band can plausibly support.
 *
 * Overlapping windows are disclosed, not hidden: daily observations of a 3-year
 * return share almost all of their span, so the effective sample is the number of
 * independent windows, not the number of days.
 *
 * Read-only. No price is emitted, no target, no instruction.
 *
 * Usage:
 *   node scripts/backtest-valuation-band.mjs
 *   node scripts/backtest-valuation-band.mjs --horizon=252 --json
 *   node scripts/backtest-valuation-band.mjs --high=14.4
 *   node scripts/backtest-valuation-band.mjs --archetype=bank
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPointInTimePeSeries } from "../src/modules/research/domain/point-in-time-pe.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const inline = args.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const asJson = args.includes("--json");
const baseUrl = option("--base-url", "http://127.0.0.1:8000").replace(/\/+$/, "");
const concurrency = Math.max(1, Number(option("--concurrency", "4")) || 4);

/**
 * The screen's real threshold.
 *
 * `valuation-screen.ts` only ever compares market cap to the *top* of the band and
 * then demands `SCREEN_MARGIN_OF_SAFETY = 0.2` on top of that:
 *
 *     marketCap ≤ netProfit × range.high × 0.8     ⇒     PE ≤ high × 0.8
 *
 * With high = 18 that is 14.4x.  `range.low` appears in `impliedLow`, which nothing
 * reads.  Testing `8 ≤ PE ≤ 18` therefore answers a question the repository never
 * asks, and answers it wrong twice: it counts PE 16 as "cheap" when the screen
 * rejects it, and it excludes PE 6 when the screen accepts it.
 */
const SCREEN_MARGIN_OF_SAFETY = 0.2;
const bandHigh = Number(option("--high", String(18 * (1 - SCREEN_MARGIN_OF_SAFETY))));
const bandLow = Number(option("--low", "0"));
const horizons = option("--horizon", "252,504,756").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const archetypeFilter = option("--archetype", "");
const marketFilter = option("--market", "CN");
/**
 * Distinguishes runs that share a date.
 *
 * The file is keyed by date, so comparing the production ceiling against the
 * textbook 8–18x band would otherwise overwrite one with the other, and the
 * comparison is the whole point: the two rules answer different questions and only
 * one of them is what the repository actually does.
 */
const label = option("--label", "");

const universe = JSON.parse(readFileSync(resolve(root, "config/investment-universe.json"), "utf8"));
const apiCodeFor = (s) => (s.market === "US" && !s.ticker.endsWith(".US") ? `${s.ticker}.US` : s.ticker);

const targets = universe.companies
  .filter((c) => c.classificationStatus === "verified")
  .filter((c) => !archetypeFilter || c.valuationArchetype === archetypeFilter)
  .filter((c) => !marketFilter || c.securities.some((s) => s.market === marketFilter))
  .map((c) => {
    const sec = c.securities.find((s) => s.ticker === c.preferredTicker) ?? c.securities[0];
    return {
      name: c.displayName,
      code: apiCodeFor(sec),
      market: sec.market,
      archetype: c.valuationArchetype ?? "other",
    };
  })
  .filter((t) => !marketFilter || t.market === marketFilter);

async function getJson(path) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(180_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.code === 200) return body.data;
    } catch {
      // retried
    }
    await new Promise((done) => setTimeout(done, 800 * (attempt + 1)));
  }
  return null;
}

/** Formal cumulative income rows only; the quarterized family is not a TTM anchor. */
function formalIncomeRows(readModel) {
  const rows = readModel?.rows ?? [];
  return rows.filter((row) => {
    const payload = row.payload ?? {};
    const type = String(payload.REPORT_TYPE ?? "").trim();
    const name = String(payload.REPORT_DATE_NAME ?? "").trim();
    if (type.endsWith("季度") || name.endsWith("季度")) return false;
    const profit = payload.PARENT_NETPROFIT ?? payload.NETPROFIT;
    return typeof profit === "number" && Number.isFinite(profit);
  });
}

async function collect(target) {
  const [readModel, kline] = await Promise.all([
    getJson(`/api/finance/income?code=${encodeURIComponent(target.code)}&limit=40&format=read-model`),
    // Backward-adjusted (`hfq`) prices are mandatory for a return calculation.
    // `normal` is the raw quoted price: 格力 traded at 35.8 in 2019-01 and 5351.35
    // backward-adjusted, a 149x gap that is entirely dividends and splits.  A
    // forward return computed on `normal` prices is not a lower estimate, it is a
    // different quantity.  Market cap is identical under either adjustment, so the
    // PE numerator is unaffected.
    getJson(`/api/kline?code=${encodeURIComponent(target.code)}&period=day&format=structured&from=2014-01-01&fq=hfq`),
  ]);
  const rows = formalIncomeRows(readModel);
  const bars = (Array.isArray(kline) ? kline : [])
    .filter((b) => typeof b.close === "number" && b.close > 0
      && typeof b.marketCapital === "number" && b.marketCapital > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0 || bars.length < 60) {
    return { ...target, excluded: rows.length === 0 ? "no point-in-time earnings" : "too few bars", observations: [] };
  }

  const series = buildPointInTimePeSeries(rows, bars.map((b) => ({ date: b.date, marketCap: b.marketCapital })));
  const peByDate = new Map(series.map((p) => [p.date, p.peTtm]));

  const observations = [];
  for (let i = 0; i < bars.length; i += 1) {
    const pe = peByDate.get(bars[i].date);
    if (typeof pe !== "number" || pe <= 0) continue;
    const forward = {};
    for (const horizon of horizons) {
      const j = i + horizon;
      forward[horizon] = j < bars.length ? bars[j].close / bars[i].close - 1 : null;
    }
    observations.push({
      date: bars[i].date,
      pe,
      inBand: pe >= bandLow && pe <= bandHigh,      forward,
    });
  }
  return { ...target, excluded: null, observations, firstDate: observations[0]?.date ?? null, lastDate: observations.at(-1)?.date ?? null };
}

let cursor = 0;
const collected = [];
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= targets.length) return;
    try {
      collected.push(await collect(targets[index]));
    } catch (error) {
      collected.push({ ...targets[index], excluded: `fetch failed: ${error instanceof Error ? error.message : String(error)}`, observations: [] });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

// ------------------------------------------------------------------ statistics
const mean = (values) => (values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length);
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
const stdev = (values) => {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
};

/**
 * Non-overlapping subsample.
 *
 * Daily observations of a one-year return overlap almost entirely: consecutive
 * days share 251 of 252 days of the same window, so 1,000 observations may carry
 * about four independent facts.  Taking every `horizon`-th day gives windows that
 * do not overlap, which is the honest count for a significance statement.
 */
function independent(observations, horizon, field) {
  const out = [];
  for (let i = 0; i < observations.length; i += horizon) {
    const value = observations[i][field]?.[horizon];
    if (typeof value === "number") out.push({ value, pe: observations[i].pe });
  }
  return out;
}

/** Welch's t-test on two independent samples. */
function welch(inside, outside) {
  if (inside.length < 2 || outside.length < 2) return null;
  const m1 = mean(inside);
  const m2 = mean(outside);
  const s1 = stdev(inside);
  const s2 = stdev(outside);
  const se = Math.sqrt((s1 * s1) / inside.length + (s2 * s2) / outside.length);
  if (!Number.isFinite(se) || se === 0) return null;
  return { t: (m1 - m2) / se, difference: m1 - m2 };
}

/**
 * One vote per company: did trading inside the band beat that company's own median?
 *
 * A pooled day-level comparison cannot separate "cheap" from "a bank".  Banks sit
 * inside the band essentially always and returned −3.0% inside vs +11.2% outside
 * at the pooled level; that number is the bank sector's 2020–2026 drawdown being
 * labelled a valuation effect, not evidence about the band.
 *
 * Asking each company separately removes the industry mix entirely: it compares a
 * company against itself, so a bank is only ever measured against other bank days.
 * The output is then just a win/loss count, which needs no normality assumption and
 * cannot be dragged by one ten-bagger.
 *
 * A company whose PE never enters the band has no inside sample and contributes no
 * vote — it is counted as `no_inside` rather than silently dropped, because "the
 * band never fires for this name" is itself the P4 finding.
 */
function votePerCompany(members, horizon, qualifies) {
  const votes = [];
  for (const company of members) {
    const rows = company.observations
      .filter((o) => typeof o.forward[horizon] === "number")
      .map((o) => ({ value: o.forward[horizon], qualifies: qualifies(o.pe) }));
    const inside = rows.filter((r) => r.qualifies).map((r) => r.value);
    const outside = rows.filter((r) => !r.qualifies).map((r) => r.value);
    const base = { code: company.code, name: company.name, archetype: company.archetype };
    if (inside.length === 0) {
      votes.push({ ...base, status: "no_inside" });
      continue;
    }
    if (outside.length === 0) {
      votes.push({ ...base, status: "no_outside" });
      continue;
    }
    const insideMedian = median(inside);
    const outsideMedian = median(outside);
    votes.push({
      ...base,
      status: "voted",
      insideMedian,
      outsideMedian,
      // A three-way outcome: cheap days were better, worse, or indistinguishable.
      // The dead band (±2pp) stops a 0.1pp difference from counting as a win.
      outcome: insideMedian - outsideMedian > 0.02 ? "better"
        : insideMedian - outsideMedian < -0.02 ? "worse" : "tie",
      difference: insideMedian - outsideMedian,
    });
  }
  return votes;
}

/**
 * Is the band a threshold, or just a gradient in disguise?
 *
 * "Cheap beats expensive" is the oldest result in equity markets and would be true
 * for any cut point.  If the effect is a smooth monotone gradient across every PE
 * bucket, then the specific number 14.4 is noise and the band is not doing work a
 * sort would not do.  If instead the effect is flat until a jump near the ceiling,
 * the threshold is doing something.
 *
 * Buckets are fixed and reported with their own counts so a thin bucket cannot be
 * mistaken for a strong one.
 */
const PE_BUCKETS = [
  { label: "0–8", test: (pe) => pe > 0 && pe < 8 },
  { label: "8–11", test: (pe) => pe >= 8 && pe < 11 },
  { label: "11–14.4", test: (pe) => pe >= 11 && pe < 14.4 },
  { label: "14.4–18", test: (pe) => pe >= 14.4 && pe < 18 },
  { label: "18–25", test: (pe) => pe >= 18 && pe < 25 },
  { label: "25–40", test: (pe) => pe >= 25 && pe < 40 },
  { label: "40–80", test: (pe) => pe >= 40 && pe < 80 },
  { label: "80+", test: (pe) => pe >= 80 },
];

function peGradient(members, horizon) {
  return PE_BUCKETS.map((bucket) => {
    const values = members.flatMap((company) => company.observations
      .filter((o) => bucket.test(o.pe) && typeof o.forward[horizon] === "number")
      .map((o) => o.forward[horizon]));
    return {
      bucket: bucket.label,
      days: values.length,
      median: median(values),
      mean: mean(values),
    };
  });
}

/**
 * Year cohorts: are the cheap days spread out, or all sitting on one bottom?
 *
 * A pooled forward return mixes two things: which stock was cheap, and *when* the
 * whole market was cheap.  If every in-band observation lands in the 2024 trough,
 * the result says "buying the index in 2024 worked", not "the band works".  The
 * honest comparison is within a year — cheap names versus expensive names on the
 * same dates, so the market's own move cancels out.
 */
function byYearCohort(members, horizon, qualifies) {
  const years = new Map();
  for (const company of members) {
    for (const o of company.observations) {
      const value = o.forward[horizon];
      if (typeof value !== "number") continue;
      const year = o.date.slice(0, 4);
      const bucket = years.get(year) ?? { inside: [], outside: [] };
      if (qualifies(o.pe)) bucket.inside.push(value);
      else bucket.outside.push(value);
      years.set(year, bucket);
    }
  }
  return [...years.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, bucket]) => ({
      year,
      daysInside: bucket.inside.length,
      daysOutside: bucket.outside.length,
      medianInside: median(bucket.inside),
      medianOutside: median(bucket.outside),
      spread: median(bucket.inside) !== null && median(bucket.outside) !== null
        ? median(bucket.inside) - median(bucket.outside)
        : null,
    }));
}

/**
 * Two-sided binomial sign test.
 *
 * The votes are not a normal sample and are not exchangeable with any t distribution,
 * but under "the band carries no information" each company is a fair coin. That is a
 * weak null and exactly the one worth testing, because it survives fat tails, skew
 * and the fact that a single ten-bagger dominates every mean in the table.
 */
function signTestP(better, worse) {
  const n = better + worse;
  if (n === 0) return null;
  const logFactorial = (k) => {
    let sum = 0;
    for (let i = 2; i <= k; i += 1) sum += Math.log(i);
    return sum;
  };
  const logPmf = (k) => logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.log(2);
  const tailStart = Math.max(better, worse);
  let tail = 0;
  for (let k = tailStart; k <= n; k += 1) tail += Math.exp(logPmf(k));
  return Math.min(1, 2 * tail);
}

const allObservations = collected.flatMap((c) => c.observations.map((o) => ({ ...o, code: c.code, archetype: c.archetype })));

const qualifies = (pe) => pe >= bandLow && pe <= bandHigh;

const summary = horizons.map((horizon) => {
  const withReturn = allObservations.filter((o) => typeof o.forward[horizon] === "number");
  const inside = withReturn.filter((o) => qualifies(o.pe)).map((o) => o.forward[horizon]);
  const outside = withReturn.filter((o) => !qualifies(o.pe)).map((o) => o.forward[horizon]);

  // Independent counts: build one series per company, then pool.
  const independentRows = collected.flatMap((c) => independent(c.observations, horizon, "forward"));
  const indepInside = independentRows.filter((r) => qualifies(r.pe)).map((r) => r.value);
  const indepOutside = independentRows.filter((r) => !qualifies(r.pe)).map((r) => r.value);
  const test = welch(indepInside, indepOutside);

  const votes = votePerCompany(collected.filter((c) => !c.excluded), horizon, qualifies);
  const voted = votes.filter((v) => v.status === "voted");
  const better = voted.filter((v) => v.outcome === "better").length;
  const worse = voted.filter((v) => v.outcome === "worse").length;

  // How many non-overlapping windows actually exist?  A three-year horizon on a
  // six-year span gives two per company, so a "t = 0.00" is a statement about
  // sample size, not about the band.
  const windowsPerCompany = collected
    .filter((c) => !c.excluded)
    .map((c) => Math.floor(c.observations.length / horizon));

  return {
    horizon,
    years: Math.round((horizon / 252) * 10) / 10,
    daysInside: inside.length,
    daysOutside: outside.length,
    meanInside: mean(inside),
    meanOutside: mean(outside),
    medianInside: median(inside),
    medianOutside: median(outside),
    independentInside: indepInside.length,
    independentOutside: indepOutside.length,
    independentMeanInside: mean(indepInside),
    independentMeanOutside: mean(indepOutside),
    test,
    overlapTest: welch(inside, outside),
    maxIndependentWindowsPerCompany: windowsPerCompany.length ? Math.max(...windowsPerCompany) : 0,
    companiesWithNoFullWindow: windowsPerCompany.filter((n) => n === 0).length,
    votes: {
      voted: voted.length,
      better,
      worse,
      tie: voted.filter((v) => v.outcome === "tie").length,
      noInside: votes.filter((v) => v.status === "no_inside").length,
      noOutside: votes.filter((v) => v.status === "no_outside").length,
      medianDifference: median(voted.map((v) => v.difference)),
      signTestP: signTestP(better, worse),
      detail: votes,
    },
  };
});

// Per archetype, so a pooled result cannot hide two opposite groups.
const archetypes = [...new Set(collected.map((c) => c.archetype))].sort();
const byArchetype = archetypes.map((archetype) => {
  const members = collected.filter((c) => c.archetype === archetype && !c.excluded);
  const horizon = horizons[0];
  const obs = members.flatMap((c) => c.observations.map((o) => ({ ...o })));
  const inside = obs.filter((o) => qualifies(o.pe) && typeof o.forward[horizon] === "number").map((o) => o.forward[horizon]);
  const outside = obs.filter((o) => !qualifies(o.pe) && typeof o.forward[horizon] === "number").map((o) => o.forward[horizon]);
  const votes = votePerCompany(members, horizon, qualifies).filter((v) => v.status === "voted");
  const better = votes.filter((v) => v.outcome === "better").length;
  const worse = votes.filter((v) => v.outcome === "worse").length;
  return {
    archetype,
    companies: members.length,
    covered: members.length,
    daysInside: inside.length,
    daysOutside: outside.length,
    meanInside: mean(inside),
    meanOutside: mean(outside),
    medianInside: median(inside),
    medianOutside: median(outside),
    votes: {
      voted: votes.length,
      better,
      worse,
      tie: votes.filter((v) => v.outcome === "tie").length,
      noInside: votePerCompany(members, horizon, qualifies).filter((v) => v.status === "no_inside").length,
      medianDifference: median(votes.map((v) => v.difference)),
    },
  };
});

const excluded = collected.filter((c) => c.excluded);
const result = {
  asOf: new Date().toISOString().slice(0, 10),
  label: label || `pe_le_${bandHigh}`,
  band: { low: bandLow, high: bandHigh },
  market: marketFilter || "all",
  companies: collected.length,
  screened: collected.length - excluded.length,
  excluded: excluded.map((c) => ({ code: c.code, name: c.name, reason: c.excluded })),
  observations: allObservations.length,
  span: {
    first: collected.map((c) => c.firstDate).filter(Boolean).sort()[0] ?? null,
    last: collected.map((c) => c.lastDate).filter(Boolean).sort().at(-1) ?? null,
  },
  summary,
  byArchetype,
  byYear: byYearCohort(collected.filter((c) => !c.excluded), horizons[0], qualifies),
  gradient: peGradient(collected.filter((c) => !c.excluded), horizons[0]),
};

const outDir = resolve(root, "reports/valuation-backtest");
mkdirSync(outDir, { recursive: true });
const outFile = label ? `${result.asOf}-${label}.json` : `${result.asOf}.json`;
writeFileSync(resolve(outDir, outFile), `${JSON.stringify(result, null, 2)}\n`);

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");

console.log(`Backtest: does PE ≤ ${bandHigh}x separate forward returns?`);
console.log("");
console.log(`Market: ${marketFilter || "all"}   companies: ${result.companies}   usable: ${result.screened}`);
console.log(`Span: ${result.span.first} .. ${result.span.last}   observations: ${result.observations}`);
console.log(`Rule: PE ≤ ${bandHigh}x (the screen's implied ceiling, = range.high × ${1 - SCREEN_MARGIN_OF_SAFETY})`);
if (excluded.length) {
  console.log("");
  console.log(`Excluded (${excluded.length}) — no point-in-time earnings or too few bars:`);
  for (const c of excluded.slice(0, 15)) console.log(`  ${c.code.padEnd(11)} ${String(c.name).padEnd(9)} ${c.reason}`);
  if (excluded.length > 15) console.log(`  …另有 ${excluded.length - 15} 家`);
}
console.log("");
console.log("Forward returns, inside vs outside the ceiling (medians are the headline):");
console.log(`${"horizon".padEnd(9)}${"days in/out".padStart(13)}${"median in".padStart(11)}${"median out".padStart(12)}${"mean in".padStart(10)}${"mean out".padStart(10)}${"windows/co".padStart(12)}`);
console.log("─".repeat(77));
for (const s of summary) {
  console.log(
    `${`${s.years}y`.padEnd(9)}`
    + `${`${s.daysInside}/${s.daysOutside}`.padStart(13)}`
    + `${pct(s.medianInside).padStart(11)}`
    + `${pct(s.medianOutside).padStart(12)}`
    + `${pct(s.meanInside).padStart(10)}`
    + `${pct(s.meanOutside).padStart(10)}`
    + `${`${s.maxIndependentWindowsPerCompany}`.padStart(12)}`,
  );
}
console.log("");
console.log("Per-company votes (each company against its own median; ±2pp is a tie):");
console.log(`${"horizon".padEnd(9)}${"better".padStart(8)}${"worse".padStart(7)}${"tie".padStart(6)}${"no inside".padStart(11)}${"median diff".padStart(13)}${"sign p".padStart(9)}`);
console.log("─".repeat(63));
for (const s of summary) {
  const v = s.votes;
  console.log(
    `${`${s.years}y`.padEnd(9)}`
    + `${String(v.better).padStart(8)}`
    + `${String(v.worse).padStart(7)}`
    + `${String(v.tie).padStart(6)}`
    + `${String(v.noInside).padStart(11)}`
    + `${pct(v.medianDifference).padStart(13)}`
    + `${(v.signTestP === null ? "—" : v.signTestP.toFixed(3)).padStart(9)}`,
  );
}
console.log("");
const h1 = summary[0];
if (h1) {
  console.log(`At ${h1.years}y: ${h1.votes.better} companies did better inside, ${h1.votes.worse} worse, `
    + `${h1.votes.tie} tied; ${h1.votes.noInside} never entered the ceiling at all.`);
  console.log("");
}
if (summary.some((s) => s.companiesWithNoFullWindow > 0)) {
  console.log("A horizon with `windows/co` ≤ 2 cannot support a significance claim — the");
  console.log("non-overlapping sample is a handful of windows, so |t| says more about sample");
  console.log("size than about the band. Read the point estimates, not the t.");
  console.log("");
}
console.log("Per archetype (first horizon, pooled days + company votes):");
console.log(`${"archetype".padEnd(23)}${"n".padStart(3)}${"days in".padStart(9)}${"med in".padStart(10)}${"med out".padStart(10)}${"better".padStart(8)}${"worse".padStart(7)}${"no in".padStart(7)}`);
console.log("─".repeat(77));
for (const a of byArchetype) {
  console.log(
    `${a.archetype.padEnd(23)}${String(a.covered).padStart(3)}${String(a.daysInside).padStart(9)}`
    + `${pct(a.medianInside).padStart(10)}${pct(a.medianOutside).padStart(10)}`
    + `${String(a.votes.better).padStart(8)}${String(a.votes.worse).padStart(7)}${String(a.votes.noInside).padStart(7)}`,
  );
}
console.log("");
console.log(`PE gradient at ${summary[0]?.years ?? "?"}y — is 14.4 a threshold or just a slope?`);
console.log(`${"PE bucket".padEnd(12)}${"days".padStart(9)}${"median".padStart(10)}${"mean".padStart(10)}`);
console.log("─".repeat(41));
for (const g of result.gradient) {
  console.log(`${g.bucket.padEnd(12)}${String(g.days).padStart(9)}${pct(g.median).padStart(10)}${pct(g.mean).padStart(10)}`);
}
console.log("");
console.log(`Year cohorts at ${summary[0]?.years ?? "?"}y — same dates, cheap vs expensive:`);
console.log(`${"year".padEnd(7)}${"days in".padStart(9)}${"days out".padStart(10)}${"med in".padStart(10)}${"med out".padStart(10)}${"spread".padStart(9)}`);
console.log("─".repeat(55));
for (const y of result.byYear) {
  console.log(
    `${y.year.padEnd(7)}${String(y.daysInside).padStart(9)}${String(y.daysOutside).padStart(10)}`
    + `${pct(y.medianInside).padStart(10)}${pct(y.medianOutside).padStart(10)}${pct(y.spread).padStart(9)}`,
  );
}
console.log("");
console.log("`indep t` uses non-overlapping windows only; the day counts above overlap and");
console.log("are not an independent sample. |t| > 2 is the conventional threshold.");
console.log(`Written to reports/valuation-backtest/${outFile}`);
