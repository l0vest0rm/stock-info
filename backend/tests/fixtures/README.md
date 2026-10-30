# Frozen original-backend contract evidence

`dashboard_domain_opportunity.json.gz` and `dashboard_screen_diff.json.gz`
retain **all 343 and 65 inputs and complete expected output objects**, respectively,
from the original TypeScript differential runners. JSON is gzip-compressed only
for size; compression is deterministic (`mtime=0`) and no fields are elided.

`retired-backend-oracles.json` records the source commit, original test and
embedded-generator SHA-256, decoded JSON SHA-256 and exact case counts. The
original embedded generators remain recoverable from that commit's Git history;
they are deliberately not retained as a backend implementation in this checkout.
Do not refresh expected values from the Rust implementation under test.

The Rust tests decode the fixtures without Node, preserve recursive complete-field
and array-length equality plus original numerical tolerances, and require exact
case counts. Their coverage still includes opportunity/policy gates, seeded edge
cases, screening, valuation assessment and point-in-time announcement semantics.

Other existing JSON goldens (portfolio, featured workflow, earnings, fund-quarterly
and buy-point) remain frozen original-source evidence. The retired JavaScript
regeneration programs have been removed; the production implementations are Rust.
