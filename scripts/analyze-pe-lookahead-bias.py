#!/usr/bin/env python3
"""How much look-ahead bias is in Xueqiu's historical peTtm?

Xueqiu's daily PE switches on the REPORT_DATE: the implied trailing profit jumps
on 2019-01-02 to the full-year 2018 figure, but the 2018 annual was published
2019-03-29.  So for ~3 months each spring the series uses earnings that did not
exist yet.

This measures the size of that error against a point-in-time reconstruction built
from Eastmoney rows filtered by NOTICE_DATE.
"""
import json
import urllib.request
import concurrent.futures
import sys

BASE = "http://127.0.0.1:8000"


def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=240) as r:
        return json.load(r).get("data")


def annual_quarterly(rows):
    """Cumulative rows by report date, with the notice date that made them public."""
    out = []
    for row in rows:
        rd = str(row.get("REPORT_DATE") or "")[:10]
        nd = str(row.get("noticeDate") or row.get("NOTICE_DATE") or "")[:10]
        name = str(row.get("REPORT_DATE_NAME") or "")
        profit = row.get("PARENT_NETPROFIT")
        if not rd or not nd or not isinstance(profit, (int, float)):
            continue
        if not name.endswith(("年报", "中报", "季报")):
            continue
        out.append({"reportDate": rd, "noticeDate": nd, "profit": profit, "name": name})
    return out


def pit_ttm(statements, as_of):
    """Trailing twelve-month profit using only rows public on `as_of`."""
    known = [s for s in statements if s["noticeDate"] <= as_of]
    if not known:
        return None
    by_name = {}
    for s in known:
        by_name.setdefault(s["reportDate"], s)
    known = sorted(by_name.values(), key=lambda s: s["reportDate"], reverse=True)
    latest = known[0]
    # Annual row: it *is* the trailing twelve months.
    if latest["name"].endswith("年报"):
        return latest["profit"]
    # Otherwise: last annual + latest cumulative - same cumulative a year ago.
    annual = next((s for s in known if s["name"].endswith("年报")), None)
    if annual is None:
        return None
    year_ago_date = f"{int(latest['reportDate'][:4]) - 1}{latest['reportDate'][4:]}"
    year_ago = by_name.get(year_ago_date)
    if year_ago is None:
        return None
    return annual["profit"] + latest["profit"] - year_ago["profit"]


def analyse(code):
    income = get(f"/api/finance/income?code={code}&limit=300")
    if not isinstance(income, list):
        return None
    statements = annual_quarterly(income)
    if not statements:
        return None
    oldest = min(s["noticeDate"] for s in statements)
    kline = get(f"/api/kline?code={code}&period=day&format=structured&from=2014-01-01")
    rows = [r for r in (kline or []) if isinstance(r.get("peTtm"), (int, float)) and r["peTtm"] > 0]

    checked = 0
    biased = 0
    worst = 0.0
    worst_date = None
    for r in rows:
        if r["date"] < oldest:
            continue
        truth = pit_ttm(statements, r["date"])
        if truth is None or truth <= 0:
            continue
        implied = r["marketCapital"] / r["peTtm"]
        err = implied / truth - 1
        checked += 1
        if abs(err) > 0.02:
            biased += 1
            if abs(err) > abs(worst):
                worst = err
                worst_date = r["date"]
    if checked == 0:
        return None
    return {
        "code": code,
        "checked": checked,
        "biasedDays": biased,
        "share": biased / checked,
        "worst": worst,
        "worstDate": worst_date,
        "from": oldest,
    }


codes = sys.argv[1:] or ["600519.SH", "000651.SZ", "600036.SH", "601318.SH",
                         "300750.SZ", "002594.SZ", "600900.SH", "601899.SH"]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
    results = [r for r in ex.map(analyse, codes) if r]

print(f"{'code':<11}{'days checked':>13}{'biased':>9}{'share':>8}{'worst err':>11}  worst date")
for r in results:
    print(f"{r['code']:<11}{r['checked']:>13}{r['biasedDays']:>9}{r['share']*100:>7.1f}%{r['worst']*100:>10.1f}%  {r['worstDate']}")
if results:
    total = sum(r["checked"] for r in results)
    bad = sum(r["biasedDays"] for r in results)
    print(f"\npooled: {bad}/{total} days = {bad/total*100:.1f}% of observations use earnings that were not yet public")
