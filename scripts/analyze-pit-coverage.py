#!/usr/bin/env python3
"""Does the look-ahead bias change the P4 coverage conclusion?

P4 said: "8–18x covers only 0–60% of each archetype's own history, so the band is
not evidence-based."  That was measured on Snowball's daily peTtm, which as of this
check carries earnings up to three months before they were published.

This recomputes the same coverage twice — raw series and point-in-time series — and
reports both, so the claim can be restated with its actual error margin instead of
being quietly left as-is.

Point-in-time series:
    PE = market cap (daily, unrevised) / TTM profit known on that day
where "known" means NOTICE_DATE <= the day.
"""
import json
import urllib.request
import concurrent.futures
from collections import defaultdict

BASE = "http://127.0.0.1:8000"
LOW, HIGH = 8.0, 18.0


def get(path):
    for _ in range(3):
        try:
            with urllib.request.urlopen(f"{BASE}{path}", timeout=240) as r:
                return json.load(r).get("data")
        except Exception:
            pass
    return None


def statements(rows):
    out = []
    for row in rows or []:
        rd = str(row.get("REPORT_DATE") or "")[:10]
        nd = str(row.get("noticeDate") or "")[:10]
        name = str(row.get("REPORT_DATE_NAME") or "")
        profit = row.get("PARENT_NETPROFIT")
        if not rd or not nd or not isinstance(profit, (int, float)):
            continue
        if not name.endswith(("年报", "中报", "季报")):
            continue
        out.append({"reportDate": rd, "noticeDate": nd, "profit": profit, "annual": name.endswith("年报")})
    return out


def pit_ttm(stmts, as_of):
    known = [s for s in stmts if s["noticeDate"] <= as_of]
    if not known:
        return None
    by_date = {}
    for s in known:
        by_date.setdefault(s["reportDate"], s)
    latest = max(by_date.values(), key=lambda s: s["reportDate"])
    if latest["annual"]:
        return latest["profit"]
    annual = next((s for s in by_date.values() if s["annual"]), None)
    if annual is None:
        return None
    yoy = by_date.get(f"{int(latest['reportDate'][:4]) - 1}{latest['reportDate'][4:]}")
    if yoy is None:
        return None
    return annual["profit"] + latest["profit"] - yoy["profit"]


def analyse(target):
    name, code, archetype = target
    stmts = statements(get(f"/api/finance/income?code={code}&limit=40"))
    kline = get(f"/api/kline?code={code}&period=day&format=structured&from=2019-01-01")
    rows = [r for r in (kline or [])
            if isinstance(r.get("peTtm"), (int, float)) and r["peTtm"] > 0
            and isinstance(r.get("marketCapital"), (int, float)) and r["marketCapital"] > 0]
    if not rows or not stmts:
        return None
    oldest = min(s["noticeDate"] for s in stmts)

    raw_in = pit_in = pit_n = 0
    for r in rows:
        if r["date"] < oldest:
            continue
        raw_in += 1 if LOW <= r["peTtm"] <= HIGH else 0
        truth = pit_ttm(stmts, r["date"])
        if truth is None or truth <= 0:
            continue
        pe = r["marketCapital"] / truth
        pit_n += 1
        pit_in += 1 if LOW <= pe <= HIGH else 0
    if pit_n == 0:
        return None
    return {
        "name": name, "code": code, "archetype": archetype,
        "rawDays": sum(1 for r in rows if r["date"] >= oldest),
        "rawIn": raw_in, "pitDays": pit_n, "pitIn": pit_in,
    }


def main():
    universe = json.load(open("config/investment-universe.json"))
    targets = []
    for c in universe["companies"]:
        if c.get("classificationStatus") != "verified":
            continue
        s = [x for x in c["securities"] if x["ticker"] == c.get("preferredTicker")] or c["securities"]
        s = s[0]
        t = s["ticker"]
        if s["market"] == "US" and not t.endswith(".US"):
            t += ".US"
        targets.append((c["displayName"], t, c.get("valuationArchetype") or "other"))

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        for r in ex.map(analyse, targets):
            if r:
                results.append(r)

    by_arch = defaultdict(lambda: [0, 0, 0, 0, 0])
    for r in results:
        e = by_arch[r["archetype"]]
        e[0] += 1
        e[1] += r["rawIn"]
        e[2] += r["rawDays"]
        e[3] += r["pitIn"]
        e[4] += r["pitDays"]

    print(f"{'archetype':<24}{'n':>3}{'raw cov':>10}{'PIT cov':>10}{'delta':>9}")
    print("-" * 58)
    for arch in sorted(by_arch, key=lambda a: -(by_arch[a][2] and by_arch[a][1] / by_arch[a][2] or 0)):
        n, ri, rd, pi, pd = by_arch[arch]
        raw = ri / rd * 100 if rd else 0
        pit = pi / pd * 100 if pd else 0
        print(f"{arch:<24}{n:>3}{raw:>9.1f}%{pit:>9.1f}%{pit-raw:>8.1f}pp")

    tr = sum(r["rawIn"] for r in results) / max(1, sum(r["rawDays"] for r in results)) * 100
    tp = sum(r["pitIn"] for r in results) / max(1, sum(r["pitDays"] for r in results)) * 100
    print("-" * 58)
    print(f"{'pooled':<24}{len(results):>3}{tr:>9.1f}%{tp:>9.1f}%{tp-tr:>8.1f}pp")
    print(f"\ncompanies with a point-in-time series: {len(results)}/97")


if __name__ == "__main__":
    main()
