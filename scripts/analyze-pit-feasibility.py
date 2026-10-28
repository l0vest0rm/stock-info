#!/usr/bin/env python3
"""Can a point-in-time PE be rebuilt for enough of the pool to backtest?

Snowball's historical `peTtm` switches on the REPORT_DATE, so ~30% of days carry
earnings that were not public yet.  Using it to test "did a cheap PE predict
returns" would leak the answer.  The fix is to rebuild PE from two clean series:

    market cap  — daily, from the K-line, no revision
    TTM profit  — Eastmoney rows filtered to NOTICE_DATE <= the day in question

This script measures whether that reconstruction is possible across the pool, and
how far back it reaches.
"""
import json
import urllib.request
import concurrent.futures
from datetime import date, timedelta

BASE = "http://127.0.0.1:8000"


def get(path):
    for _ in range(3):
        try:
            with urllib.request.urlopen(f"{BASE}{path}", timeout=240) as r:
                return json.load(r).get("data")
        except Exception:
            pass
    return None


def depth(code):
    d = get(f"/api/finance/income?code={code}&limit=40")
    if not isinstance(d, list) or not d:
        return code, None, 0, 0
    dated = [r for r in d if str(r.get("REPORT_DATE_NAME") or "").endswith(("年报", "中报", "季报"))]
    notices = [str(r.get("noticeDate") or "")[:10] for r in dated if r.get("noticeDate")]
    oldest = min(notices) if notices else None
    return code, oldest, len(dated), len(notices)


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
        targets.append((c["displayName"], t, s["market"]))

    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        for code, oldest, n, nn in ex.map(depth, [t[1] for t in targets]):
            name, market = next(((x[0], x[2]) for x in targets if x[1] == code), ("?", "?"))
            rows.append((code, name, market, oldest, n, nn))

    enough = [r for r in rows if r[3] and r[3] <= "2019-06-01"]
    print(f"companies: {len(rows)}")
    print(f"  income reaching back to 2019-06: {len(enough)}")
    by_market = {}
    for r in rows:
        key = r[2]
        e = by_market.setdefault(key, [0, 0])
        e[0] += 1
        if r[3] and r[3] <= "2019-06-01":
            e[1] += 1
    print("\nby market (total / reaches 2019-06):")
    for k, (total, ok) in sorted(by_market.items()):
        print(f"  {k:<4} {total:>3} / {ok:>3}")

    shallow = [r for r in rows if not r[3] or r[3] > "2019-06-01"]
    if shallow:
        print(f"\nshallow or no noticeDate ({len(shallow)}):")
        for r in shallow[:20]:
            print(f"  {r[0]:<11}{r[1][:10]:<11}{r[2]:<4}oldest notice {r[3]}  rows {r[4]}  withNoticeDate {r[5]}")

    print("\nspan implied by the oldest notice date:")
    oldest = min((r[3] for r in rows if r[3]), default=None)
    print(f"  {oldest} .. 2026-10-28  = {(date(2026,10,28)-date.fromisoformat(oldest)).days/365.25:.1f} years")


if __name__ == "__main__":
    main()
