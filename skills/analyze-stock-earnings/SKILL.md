---
name: analyze-stock-earnings
description: Use when the user asks to analyze or recommend Chinese stocks from recent earnings forecasts, preliminary earnings, financial growth, 2026 or other forward PE scenarios, analyst forecasts, or related valuation and risk evidence, and wants a Markdown research shortlist.
---

# Analyze Stock Earnings

Use this skill as the natural-language entrypoint for the deterministic earnings research CLI in `/Users/terry/git/stock-info`.

## Core Flow

1. Work in `/Users/terry/git/stock-info`.
2. Convert the request into an exact Asia/Shanghai `as-of` date, recent-day window, candidate limit, and optional report date.
3. Run:
   ```bash
   npm run research:earnings -- --as-of YYYY-MM-DD --days N --limit N
   ```
4. Add `--include-consensus` only when the user asks to incorporate analyst or research-report forecasts; this endpoint can be slow.
5. Read the generated `request.json`, `evidence.json`, `evidence.md`, and `prompt.md` from the output directory printed by the CLI.
6. Follow `prompt.md` and write the finished analysis to the exact `recommendationsPath` printed by the CLI.
7. Verify that the Markdown contains the data cutoff, report period, ranked candidates, evidence, valuation scenarios, risks, invalidation conditions, exclusions, and data limitations.
8. Return the Markdown path and a concise summary. Report any skipped or failed data source explicitly.

## Guardrails

- Treat CLI calculations as the numeric source of truth; do not recompute units or fill missing values.
- Use the CLI run-rate Forward PE: quarterly cumulative profit is annualized as Q1 ×4, H1 ×2, 9M ×4/3, and FY ×1.
- Prioritize effective growth and Forward PE together. Effective growth is QoQ-led; ignore YoY when the prior base is non-positive, too small, or above the configured outlier threshold.
- Treat `PE/有效增速` as a PEG-like screening aid, not standard long-term PEG.
- Do not use evidence dated after `as-of`.
- Treat the CLI candidate order as data collection order, not the final ranking.
- Distinguish company disclosures from analyst forecasts and model projections.
- Keep negative-profit PE empty and preserve missing同比/环比 as unavailable.
- Present research candidates, not guaranteed returns or unconditional buy instructions.

## Evidence of Success

- `recommendations.md` exists at the printed path.
- Every recommended company has supporting facts, a forward-profit/PE scenario, major risks, and a falsifiable invalidation condition.
- The final caveats disclose missing consensus data, low-confidence annualization, or incomplete quarter history when present in the evidence.
