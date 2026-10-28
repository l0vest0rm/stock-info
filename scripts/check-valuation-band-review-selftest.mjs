/**
 * Deterministic check for valuation band vintages.
 * Run: node scripts/check-valuation-band-review-selftest.mjs
 *
 * The whole reason this module exists is that one visible change — a band moving
 * — has several incompatible causes.  These cases pin the attribution:
 * - a new filing moves the denominator date  → `filing`
 * - we edited DEFAULT_RANGES                 → `model`
 * - the quote provider failed                → `price_source`
 * - anything else                            → `unattributed`, never guessed
 *
 * A snapshot also must never carry a price: it is written into committed files.
 */
import assert from "node:assert/strict";
import {
  diffBandSnapshots,
  snapshotFromReadModel,
} from "../src/modules/research/domain/valuation-band-review.ts";
import { buildValuationBands } from "../src/modules/finance/domain/valuation-bands.ts";

const YI = 100_000_000;

function readModel(overrides = {}) {
  return buildValuationBands({
    code: "300308.SZ",
    archetype: "growth_manufacturing",
    asOf: { income: "2026-06-30", balance: "2026-06-30", cashflow: "2026-06-30" },
    ttm: { netProfit: 50 * YI, revenue: 400 * YI, ebit: 80 * YI, ebitda: 100 * YI, operatingCashFlow: 90 * YI, freeCashFlow: 40 * YI },
    balance: { parentEquity: 200 * YI, grossDebt: 100 * YI, cash: 60 * YI, debtIncomplete: false },
    marketCap: 1000 * YI,
    ...overrides,
  });
}

const snapshotAt = (asOf, companies) => ({
  asOf,
  capturedAt: `${asOf}T09:00:00.000Z`,
  companies: companies.map((company) => company),
});

const company = (readModelValue, companyId = "co-0001") => snapshotFromReadModel(readModelValue, companyId);

// 1. A snapshot carries no price, even though the read model was given one.
const withPrice = company(readModel());
assert.equal(JSON.stringify(withPrice).includes("implied"), false, "a snapshot must not carry the implied price column");
assert.equal(JSON.stringify(withPrice).includes("marketCap"), false, "a snapshot must not carry market capitalisation");
assert.ok(withPrice.bands.every((band) => band.range === null || typeof band.range.low === "number"), "ranges survive");
assert.equal(withPrice.bands.find((band) => band.key === "pe_ttm").denominator.reportDate, "2026-06-30");

// 2. Nothing changed: no change entries, company counted as unchanged.
const identical = diffBandSnapshots(snapshotAt("2026-10-27", [withPrice]), snapshotAt("2026-10-28", [company(readModel())]));
assert.equal(identical.changes.length, 0, "identical vintages produce no changes");
assert.deepEqual(identical.unchanged, ["co-0001"]);
assert.equal(identical.compared, 1);

// 3. New filing.  Crucially the band stays `available` with the same multiple
//    range — only the anchor moves.  This is the most common real change and the
//    one a status-only diff would miss entirely.
const newFiling = diffBandSnapshots(
  snapshotAt("2026-10-27", [withPrice]),
  snapshotAt("2026-10-28", [company(readModel({ asOf: { income: "2026-09-30", balance: "2026-09-30", cashflow: "2026-09-30" } }))]),
);
const filingChange = newFiling.changes.find((item) => item.band === "pe_ttm");
assert.ok(filingChange, "a new report period must be reported");
assert.equal(filingChange.kind, "denominator_changed");
assert.equal(filingChange.attribution, "filing");
assert.ok(filingChange.note.includes("新一期报告"), filingChange.note);
// Only the anchor moved: the range itself did not, so no range change is claimed.
assert.equal(newFiling.changes.some((item) => item.kind === "range_changed"), false, "an unchanged multiple is not a model change");

// 4. Our own DEFAULT_RANGES edit is a `model` change and says so.  This is the
//    case most likely to be misreported as company news.
const widerModel = buildValuationBands({
  code: "300308.SZ",
  archetype: "growth_manufacturing",
  asOf: { income: "2026-06-30", balance: "2026-06-30", cashflow: "2026-06-30" },
  ttm: { netProfit: 50 * YI, revenue: 400 * YI, ebit: 80 * YI, ebitda: 100 * YI, freeCashFlow: 40 * YI },
  balance: { parentEquity: 200 * YI, grossDebt: 100 * YI, cash: 60 * YI, debtIncomplete: false },
});
// Force a range move the way a real model edit would: same inputs, edited ranges.
const edited = structuredClone(widerModel);
edited.bands = edited.bands.map((band) => band.key === "pe_ttm" ? { ...band, range: { low: 10, high: 22 } } : band);
const modelChange = diffBandSnapshots(snapshotAt("2026-10-27", [company(widerModel)]), snapshotAt("2026-10-28", [company(edited)]));
const rangeChange = modelChange.changes.find((item) => item.kind === "range_changed");
assert.ok(rangeChange, "an edited multiple range must be reported");
assert.equal(rangeChange.attribution, "model", "our own range edit is never a company event");
assert.ok(rangeChange.note.includes("模型变更"), rangeChange.note);

// 5. Quote provider fails: the yield band loses its denominator requirement and
//    reports `price_source`, not a valuation change.
const withQuote = company(readModel());
const withoutQuote = company(readModel({ marketCap: null }));
const outage = diffBandSnapshots(snapshotAt("2026-10-27", [withQuote]), snapshotAt("2026-10-28", [withoutQuote]));
const yieldDrop = outage.changes.find((item) => item.band === "fcf_yield");
assert.ok(yieldDrop, "FCF yield reacts to a missing quote");
assert.equal(yieldDrop.attribution, "price_source");
assert.ok(yieldDrop.note.includes("行情源"), yieldDrop.note);
// PE anchors to statements, so a missing quote must NOT move it.
assert.equal(outage.changes.some((item) => item.band === "pe_ttm"), false, "a missing quote must not disturb a statement-anchored band");

// 6. Archetype change is reported once, as a model change, before its knock-ons.
const asBank = company(readModel({ archetype: "bank" }));
const archetypeChange = diffBandSnapshots(snapshotAt("2026-10-27", [withQuote]), snapshotAt("2026-10-28", [asBank]));
const archetypeEntry = archetypeChange.changes.find((item) => item.kind === "archetype_changed");
assert.ok(archetypeEntry, "archetype change is explicit");
assert.equal(archetypeEntry.attribution, "model");
assert.ok(archetypeChange.changes.some((item) => item.kind === "became_forbidden"), "forbidden bands surface as their own change");

// 7. Honest gap: an unavailable band with no explainable cause is `unattributed`,
//    never silently attributed to the company.
const synthetic = (status, missingInputs) => ({
  companyId: "co-0002",
  code: "TEST.SH",
  archetype: "growth_manufacturing",
  asOf: { income: "2026-06-30", balance: "2026-06-30", cashflow: "2026-06-30" },
  bands: [{ key: "pe_ttm", status, role: "primary", range: status === "available" ? { low: 8, high: 18 } : null, unit: status === "available" ? "multiple" : null, denominator: null, missingInputs }],
});
const unknown = diffBandSnapshots(
  snapshotAt("2026-10-27", [synthetic("available", [])]),
  snapshotAt("2026-10-28", [synthetic("insufficient_data", ["某个未归类的输入"])]),
);
assert.equal(unknown.changes[0].attribution, "unattributed");
assert.ok(unknown.changes[0].note.includes("无法归因"), unknown.changes[0].note);

// 8. Companies that only exist in one vintage are listed, never diffed against
//    an absent counterpart.
const onlyNow = diffBandSnapshots(snapshotAt("2026-10-27", []), snapshotAt("2026-10-28", [withQuote]));
assert.deepEqual(onlyNow.added, ["co-0001"]);
assert.equal(onlyNow.changes.length, 0, "an added company produces no band changes");
const onlyThen = diffBandSnapshots(snapshotAt("2026-10-27", [withQuote]), snapshotAt("2026-10-28", []));
assert.deepEqual(onlyThen.removed, ["co-0001"]);
assert.equal(onlyThen.changes.length, 0);

console.log("valuation-band-review self-test: ok", {
  attributions: [...new Set([...identical.changes, ...newFiling.changes, ...modelChange.changes, ...outage.changes, ...archetypeChange.changes, ...unknown.changes].map((item) => item.attribution))],
  kinds: [...new Set([...newFiling.changes, ...modelChange.changes, ...outage.changes, ...archetypeChange.changes].map((item) => item.kind))],
});

