use super::*;

/// All observations retain the source model's basis, period and input lineage.
/// Missing data is never zero and unlike bases are never combined.
pub(super) fn build(series: &[Series], facts: &[Fact], entity_type: &str) -> Vec<Observation> {
    let mut result = Vec::new();
    for basis in unique_bases(series) {
        for frequency in ["annual", "quarterly", "ttm"] {
            let group = group(series, &basis, frequency);
            for period in unique_periods(
                group
                    .iter()
                    .flat_map(|s| s.points.iter().map(|p| p.period.clone()))
                    .collect(),
            ) {
                let c = Context {
                    series: &group,
                    facts,
                    basis: &basis,
                    frequency,
                    period: &period,
                    entity: entity_type,
                };
                result.extend([
                    c.ratio("gross_margin", "gross_profit", "revenue"),
                    c.ratio("operating_margin", "operating_profit", "revenue"),
                    c.ratio("net_margin", "net_profit", "revenue"),
                    c.free_cash_flow(),
                    c.fcf_margin(),
                    c.ratio(
                        "capital_expenditure_to_revenue",
                        "capital_expenditure",
                        "revenue",
                    ),
                    c.cash_conversion(),
                    c.per_share(
                        "net_profit_per_share",
                        "net_profit",
                        "diluted_weighted_average_shares",
                    ),
                    c.per_share(
                        "free_cash_flow_per_share",
                        "free_cash_flow",
                        "diluted_weighted_average_shares",
                    ),
                    c.effective_tax_rate(),
                    c.nopat(),
                    c.shareholder_distributions(),
                    c.net_equity_distribution(),
                ]);
            }
        }
        for frequency in ["annual", "quarterly"] {
            let group = group(series, &basis, frequency);
            for period in unique_periods(
                group
                    .iter()
                    .flat_map(|s| s.points.iter().map(|p| p.period.clone()))
                    .collect(),
            ) {
                let c = Context {
                    series: &group,
                    facts,
                    basis: &basis,
                    frequency,
                    period: &period,
                    entity: entity_type,
                };
                result.extend([
                    c.net_debt(),
                    c.per_share("book_value_per_share", "total_equity", "diluted_shares"),
                    c.working_capital(),
                    c.working_capital_to_revenue(),
                    c.ratio("receivables_to_revenue", "trade_receivables", "revenue"),
                    c.ratio("inventory_to_revenue", "inventory", "revenue"),
                    c.ratio("payables_to_revenue", "trade_payables", "revenue"),
                    c.current_ratio(),
                    c.quick_ratio(),
                    c.ratio("debt_to_equity", "total_debt", "total_equity"),
                    c.interest_coverage(),
                    c.turnover_days(
                        "days_sales_outstanding",
                        "trade_receivables",
                        &["trade_receivables", "contract_assets"],
                        "revenue",
                        "trade_receivables + contract_assets",
                    ),
                    c.turnover_days(
                        "days_inventory_outstanding",
                        "inventory",
                        &["inventory"],
                        "cost_of_revenue",
                        "inventory",
                    ),
                    c.turnover_days(
                        "days_payables_outstanding",
                        "trade_payables",
                        &["trade_payables"],
                        "cost_of_revenue",
                        "trade_payables",
                    ),
                ]);
                result.push(c.cash_conversion_cycle(&result));
                result.push(c.invested_capital());
                result.push(c.net_dilution_rate());
            }
        }
        for frequency in ["annual", "ttm"] {
            let flows = group(series, &basis, frequency);
            let balances = group(
                series,
                &basis,
                if frequency == "annual" {
                    "annual"
                } else {
                    "quarterly"
                },
            );
            if let Some(profits) = flows.iter().find(|s| s.metric == "net_profit") {
                for point in &profits.points {
                    let c = Context {
                        series: &flows,
                        facts,
                        basis: &basis,
                        frequency,
                        period: &point.period,
                        entity: entity_type,
                    };
                    result.extend([
                        c.return_on_average_balance(&balances, "return_on_equity", "total_equity"),
                        c.return_on_average_balance(&balances, "return_on_assets", "total_assets"),
                        c.roic(&balances),
                        c.incremental_roic(&balances),
                    ]);
                }
            }
        }
    }
    if entity_type == "unknown" {
        let excluded = [
            "free_cash_flow_margin",
            "cash_conversion",
            "free_cash_flow_per_share",
            "nopat",
            "working_capital",
            "working_capital_to_revenue",
            "current_ratio",
            "quick_ratio",
            "interest_coverage",
            "days_sales_outstanding",
            "days_inventory_outstanding",
            "days_payables_outstanding",
            "cash_conversion_cycle",
            "invested_capital",
            "return_on_assets",
            "return_on_invested_capital",
            "incremental_roic",
        ];
        for item in &mut result {
            if excluded.contains(&item.kind.as_str()) {
                item.status = "missing".into();
                item.value = None;
                item.reason_codes = vec!["entity_financial_profile_unconfirmed".into()];
                item.inputs.clear();
            }
        }
    }
    result
}

fn group(series: &[Series], basis: &Basis, frequency: &str) -> Vec<Series> {
    series
        .iter()
        .filter(|s| basis_key(&s.basis) == basis_key(basis) && s.frequency == frequency)
        .cloned()
        .collect()
}

struct Context<'a> {
    series: &'a [Series],
    facts: &'a [Fact],
    basis: &'a Basis,
    frequency: &'a str,
    period: &'a Period,
    entity: &'a str,
}

impl<'a> Context<'a> {
    fn at<'b>(&'b self, period: &'b Period) -> Context<'b> {
        Context {
            series: self.series,
            facts: self.facts,
            basis: self.basis,
            frequency: self.frequency,
            period,
            entity: self.entity,
        }
    }
    fn b(&self, kind: &str, metric: &str) -> Observation {
        base(kind, metric, self.basis, self.frequency, self.period)
    }
    fn point(&self, metric: &str) -> Option<Point> {
        find_point(self.series, metric, self.period).cloned()
    }
    fn points(&self, metrics: &[&str]) -> Vec<Option<Point>> {
        metrics.iter().map(|m| self.point(m)).collect()
    }

    fn ratio(&self, kind: &str, numerator: &str, denominator: &str) -> Observation {
        self.divide(
            kind,
            numerator,
            &[numerator, denominator],
            &format!("{numerator} / {denominator}"),
            "percent",
            100.0,
        )
    }
    fn divide(
        &self,
        kind: &str,
        metric: &str,
        labels: &[&str; 2],
        formula: &str,
        unit: &str,
        multiplier: f64,
    ) -> Observation {
        let b = self.b(kind, metric);
        let points = self.points(labels);
        if let Some(unavailable) =
            unavailable_inputs(&b, self.facts, labels, self.period, self.basis, &points)
        {
            return formatted(unavailable, formula, unit);
        }
        divide_points(b, formula, unit, multiplier, &points, labels)
    }

    fn free_cash_flow(&self) -> Observation {
        let b = self.b("free_cash_flow", "free_cash_flow");
        let formula = "operating_cash_flow - capital_expenditure";
        if self.entity == "financial" {
            return not_applicable(b, formula, "financial_company_fcf_not_applicable");
        }
        let labels = ["operating_cash_flow", "capital_expenditure"];
        let points = self.points(&labels);
        if let Some(unavailable) =
            unavailable_inputs(&b, self.facts, &labels, self.period, self.basis, &points)
        {
            return formatted(unavailable, formula, &self.basis.currency);
        }
        available(
            b,
            val(&points[0]) - val(&points[1]),
            "operating_cash_flow - capital_expenditure (capital expenditure is a positive outflow)",
            &self.basis.currency,
            &points,
        )
    }
    fn fcf_margin(&self) -> Observation {
        let b = self.b("free_cash_flow_margin", "free_cash_flow");
        let formula = "free_cash_flow / revenue";
        if self.entity == "financial" {
            return not_applicable(b, formula, "financial_company_fcf_not_applicable");
        }
        let points = [
            Some(as_point(&self.free_cash_flow())),
            self.point("revenue"),
        ];
        divide_points(
            b,
            formula,
            "percent",
            100.0,
            &points,
            &["free_cash_flow", "revenue"],
        )
    }
    fn working_capital(&self) -> Observation {
        let b = self.b("working_capital", "working_capital");
        let formula = "trade_receivables + contract_assets + inventory - trade_payables";
        if self.entity == "financial" {
            return not_applicable(
                b,
                formula,
                "financial_company_working_capital_not_applicable",
            );
        }
        let labels = [
            "trade_receivables",
            "contract_assets",
            "inventory",
            "trade_payables",
        ];
        let points = self.points(&labels);
        if let Some(unavailable) =
            unavailable_inputs(&b, self.facts, &labels, self.period, self.basis, &points)
        {
            return formatted(unavailable, formula, &self.basis.currency);
        }
        available(
            b,
            val(&points[0]) + val(&points[1]) + val(&points[2]) - val(&points[3]),
            formula,
            &self.basis.currency,
            &points,
        )
    }
    fn working_capital_to_revenue(&self) -> Observation {
        let b = self.b("working_capital_to_revenue", "working_capital");
        let formula = "working_capital / revenue";
        if self.entity == "financial" {
            return not_applicable(
                b,
                formula,
                "financial_company_working_capital_not_applicable",
            );
        }
        divide_points(
            b,
            formula,
            "percent",
            100.0,
            &[
                Some(as_point(&self.working_capital())),
                self.point("revenue"),
            ],
            &["working_capital", "revenue"],
        )
    }
    fn current_ratio(&self) -> Observation {
        let b = self.b("current_ratio", "current_assets");
        let formula = "current_assets / current_liabilities";
        if self.entity == "financial" {
            return not_applicable(b, formula, "financial_company_current_ratio_not_applicable");
        }
        self.divide(
            "current_ratio",
            "current_assets",
            &["current_assets", "current_liabilities"],
            formula,
            "times",
            1.0,
        )
    }
    fn quick_ratio(&self) -> Observation {
        let b = self.b("quick_ratio", "current_assets");
        let formula = "(cash + trade_receivables + contract_assets) / current_liabilities";
        if self.entity == "financial" {
            return not_applicable(b, formula, "financial_company_quick_ratio_not_applicable");
        }
        let labels = ["cash", "trade_receivables", "contract_assets"];
        let quick = combine_points(
            &b,
            "cash + trade_receivables + contract_assets",
            &self.points(&labels),
            &labels,
        );
        divide_points(
            b,
            formula,
            "times",
            1.0,
            &[Some(quick), self.point("current_liabilities")],
            &["quick_assets", "current_liabilities"],
        )
    }
    fn interest_coverage(&self) -> Observation {
        let b = self.b("interest_coverage", "operating_profit");
        let formula = "operating_profit / interest_expense";
        if self.entity == "financial" {
            return not_applicable(
                b,
                formula,
                "financial_company_interest_coverage_not_applicable",
            );
        }
        let mut result = self.divide(
            "interest_coverage",
            "operating_profit",
            &["operating_profit", "interest_expense"],
            formula,
            "times",
            1.0,
        );
        if result.status == "available" {
            let profit = self.point("operating_profit").unwrap().value.unwrap();
            let interest = self.point("interest_expense").unwrap().value.unwrap();
            if profit <= 0.0 || interest <= 0.0 {
                result.status = "not_applicable".into();
                result.value = None;
                result.reason_codes = vec![
                    if profit <= 0.0 {
                        "non_positive_operating_profit"
                    } else {
                        "non_positive_interest_expense"
                    }
                    .into(),
                ];
            }
        }
        result
    }
    fn effective_tax_rate(&self) -> Observation {
        let b = self.b("effective_tax_rate", "income_tax_expense");
        let formula = "income_tax_expense / pre_tax_profit";
        let labels = ["income_tax_expense", "pre_tax_profit"];
        let points = self.points(&labels);
        if let Some(unavailable) =
            unavailable_inputs(&b, self.facts, &labels, self.period, self.basis, &points)
        {
            return formatted(unavailable, formula, "percent");
        }
        let tax = val(&points[0]);
        let pretax = val(&points[1]);
        if pretax <= 0.0 || tax < 0.0 || tax > pretax {
            return unusable(
                b,
                "not_applicable",
                if pretax <= 0.0 {
                    "non_positive_pre_tax_profit"
                } else {
                    "tax_rate_outside_0_100_percent"
                },
                formula,
                "percent",
                &points,
            );
        }
        available(b, tax / pretax * 100.0, formula, "percent", &points)
    }
    fn nopat(&self) -> Observation {
        let b = self.b("nopat", "nopat");
        let formula = "operating_profit × (1 - effective_tax_rate)";
        if self.entity == "financial" {
            return not_applicable(b, formula, "financial_company_nopat_not_applicable");
        }
        let points = [
            self.point("operating_profit"),
            Some(as_point(&self.effective_tax_rate())),
        ];
        if let Some(unavailable) =
            unavailable_points(&b, &points, &["operating_profit", "effective_tax_rate"])
        {
            return formatted(unavailable, formula, &self.basis.currency);
        }
        available(
            b,
            val(&points[0]) * (1.0 - val(&points[1]) / 100.0),
            formula,
            &self.basis.currency,
            &points,
        )
    }
    fn shareholder_distributions(&self) -> Observation {
        let b = self.b("shareholder_distributions", "shareholder_distributions");
        let formula = "dividends_paid + share_repurchases";
        let labels = ["dividends_paid", "share_repurchases"];
        let points = self.points(&labels);
        if let Some(unavailable) =
            unavailable_inputs(&b, self.facts, &labels, self.period, self.basis, &points)
        {
            return formatted(unavailable, formula, &self.basis.currency);
        }
        available(
            b,
            val(&points[0]) + val(&points[1]),
            "dividends_paid + share_repurchases (positive cash outflows)",
            &self.basis.currency,
            &points,
        )
    }
    fn net_equity_distribution(&self) -> Observation {
        let b = self.b("net_equity_distribution", "net_equity_distribution");
        let formula = "shareholder_distributions - share_issuance";
        let points = [
            Some(as_point(&self.shareholder_distributions())),
            self.point("share_issuance"),
        ];
        if let Some(unavailable) = unavailable_points(
            &b,
            &points,
            &["shareholder_distributions", "share_issuance"],
        ) {
            return formatted(unavailable, formula, &self.basis.currency);
        }
        available(
            b,
            val(&points[0]) - val(&points[1]),
            formula,
            &self.basis.currency,
            &points,
        )
    }
    fn turnover_days(
        &self,
        kind: &str,
        metric: &str,
        balance_metrics: &[&str],
        denominator_metric: &str,
        label: &str,
    ) -> Observation {
        let b = self.b(kind, metric);
        let financial_formula = format!("average({label}) / {denominator_metric} × days");
        if self.entity == "financial" {
            return not_applicable(
                b,
                &financial_formula,
                "financial_company_cash_conversion_cycle_not_applicable",
            );
        }
        let current = combine_points(&b, label, &self.points(balance_metrics), balance_metrics);
        let prior_period = prior_comparable_period(self.period, self.frequency, 1);
        let prior_context = self.at(&prior_period);
        let prior = combine_points(
            &b,
            label,
            &prior_context.points(balance_metrics),
            balance_metrics,
        );
        let points = [Some(current), Some(prior), self.point(denominator_metric)];
        let prior_label = format!("prior_{label}");
        let labels = [label, prior_label.as_str(), denominator_metric];
        let formula = format!("average({label}) / {denominator_metric} × period_days");
        if let Some(unavailable) = unavailable_points(&b, &points, &labels) {
            return formatted(unavailable, &formula, "days");
        }
        let denominator = val(&points[2]);
        if denominator <= 0.0 {
            return unusable(
                b,
                "not_applicable",
                &format!("non_positive_{denominator_metric}"),
                &formula,
                "days",
                &points,
            );
        }
        available(
            b,
            (val(&points[0]) + val(&points[1])) / 2.0 / denominator
                * period_days(self.period) as f64,
            &formula,
            "days",
            &points,
        )
    }
    fn cash_conversion_cycle(&self, observations: &[Observation]) -> Observation {
        let b = self.b("cash_conversion_cycle", "working_capital");
        let formula = "DSO + DIO - DPO";
        if self.entity == "financial" {
            return not_applicable(
                b,
                formula,
                "financial_company_cash_conversion_cycle_not_applicable",
            );
        }
        let labels = [
            "days_sales_outstanding",
            "days_inventory_outstanding",
            "days_payables_outstanding",
        ];
        let points: Vec<_> = labels
            .iter()
            .map(|kind| {
                observations
                    .iter()
                    .find(|o| {
                        o.kind == *kind
                            && o.frequency == self.frequency
                            && o.period.end_date == self.period.end_date
                            && basis_key(&o.basis) == basis_key(self.basis)
                    })
                    .map(as_point)
            })
            .collect();
        if let Some(unavailable) = unavailable_points(&b, &points, &labels) {
            return formatted(unavailable, formula, "days");
        }
        available(
            b,
            val(&points[0]) + val(&points[1]) - val(&points[2]),
            formula,
            "days",
            &points,
        )
    }
    fn invested_capital(&self) -> Observation {
        let b = self.b("invested_capital", "invested_capital");
        let formula = "total_equity + total_debt - cash";
        if self.entity == "financial" {
            return not_applicable(
                b,
                formula,
                "financial_company_invested_capital_not_applicable",
            );
        }
        let labels = ["total_equity", "total_debt", "cash"];
        let points = self.points(&labels);
        if let Some(unavailable) =
            unavailable_inputs(&b, self.facts, &labels, self.period, self.basis, &points)
        {
            return formatted(unavailable, formula, &self.basis.currency);
        }
        let value = val(&points[0]) + val(&points[1]) - val(&points[2]);
        if value <= 0.0 {
            return unusable(
                b,
                "not_applicable",
                "non_positive_invested_capital",
                formula,
                &self.basis.currency,
                &points,
            );
        }
        available(b, value, formula, &self.basis.currency, &points)
    }
    fn net_dilution_rate(&self) -> Observation {
        let b = self.b("net_dilution_rate", "diluted_shares");
        let formula = "current diluted_shares / prior diluted_shares - 1";
        let previous_period = prior_comparable_period(self.period, self.frequency, 1);
        let points = [
            self.point("diluted_shares"),
            find_point(self.series, "diluted_shares", &previous_period).cloned(),
        ];
        if let Some(unavailable) = unavailable_inputs(
            &b,
            self.facts,
            &["diluted_shares", "diluted_shares"],
            self.period,
            self.basis,
            &points,
        ) {
            return formatted(unavailable, formula, "percent");
        }
        if val(&points[1]) <= 0.0 {
            return unusable(
                b,
                "not_applicable",
                "non_positive_prior_diluted_shares",
                formula,
                "percent",
                &points,
            );
        }
        available(
            b,
            (val(&points[0]) / val(&points[1]) - 1.0) * 100.0,
            formula,
            "percent",
            &points,
        )
    }
    fn net_debt(&self) -> Observation {
        let b = self.b("net_debt", "net_debt");
        let formula = "total_debt - cash";
        let labels = ["total_debt", "cash"];
        let points = self.points(&labels);
        if let Some(unavailable) =
            unavailable_inputs(&b, self.facts, &labels, self.period, self.basis, &points)
        {
            return formatted(unavailable, formula, &self.basis.currency);
        }
        available(
            b,
            val(&points[0]) - val(&points[1]),
            formula,
            &self.basis.currency,
            &points,
        )
    }
    fn cash_conversion(&self) -> Observation {
        let b = self.b("cash_conversion", "operating_cash_flow");
        let formula = "operating_cash_flow / net_profit";
        if self.entity == "financial" {
            return not_applicable(
                b,
                formula,
                "financial_company_cash_conversion_not_applicable",
            );
        }
        let labels = ["operating_cash_flow", "net_profit"];
        let points = self.points(&labels);
        if let Some(unavailable) =
            unavailable_inputs(&b, self.facts, &labels, self.period, self.basis, &points)
        {
            return formatted(unavailable, formula, "percent");
        }
        if val(&points[1]) <= 0.0 {
            return unusable(
                b,
                "not_applicable",
                "non_positive_profit_denominator",
                formula,
                "percent",
                &points,
            );
        }
        available(
            b,
            val(&points[0]) / val(&points[1]) * 100.0,
            formula,
            "percent",
            &points,
        )
    }
    fn per_share(&self, kind: &str, numerator: &str, shares: &str) -> Observation {
        let b = self.b(kind, numerator);
        let formula = format!("{numerator} / {shares}");
        let unit = format!("{}/share", self.basis.currency);
        if numerator == "free_cash_flow" && self.entity == "financial" {
            return not_applicable(
                b,
                "free_cash_flow / diluted_weighted_average_shares",
                "financial_company_fcf_not_applicable",
            );
        }
        let numerator_point = if numerator == "free_cash_flow" {
            Some(as_point(&self.free_cash_flow()))
        } else {
            self.point(numerator)
        };
        let points = [numerator_point, self.point(shares)];
        if let Some(unavailable) = unavailable_inputs(
            &b,
            self.facts,
            &[numerator, shares],
            self.period,
            self.basis,
            &points,
        ) {
            return formatted(unavailable, &formula, &unit);
        }
        if val(&points[1]) <= 0.0 {
            return unusable(
                b,
                "not_applicable",
                "non_positive_share_denominator",
                &formula,
                &unit,
                &points,
            );
        }
        available(
            b,
            val(&points[0]) / val(&points[1]),
            &formula,
            &unit,
            &points,
        )
    }
    fn return_on_average_balance(
        &self,
        balances: &[Series],
        kind: &str,
        metric: &str,
    ) -> Observation {
        let b = self.b(kind, "net_profit");
        let formula = format!("net_profit / average({metric})");
        if kind == "return_on_assets" && self.entity == "financial" {
            return not_applicable(
                b,
                &formula,
                "financial_company_return_on_assets_not_applicable",
            );
        }
        let prior = prior_comparable_period(
            self.period,
            if self.frequency == "annual" {
                "annual"
            } else {
                "quarterly"
            },
            if self.frequency == "annual" { 1 } else { 4 },
        );
        let points = [
            self.point("net_profit"),
            find_point(balances, metric, self.period).cloned(),
            find_point(balances, metric, &prior).cloned(),
        ];
        if let Some(unavailable) = unavailable_inputs(
            &b,
            self.facts,
            &["net_profit", metric, metric],
            self.period,
            self.basis,
            &points,
        ) {
            return formatted(unavailable, &formula, "percent");
        }
        average_balance(b, &formula, &points)
    }
    fn balance_context<'b>(&'b self, balances: &'b [Series], period: &'b Period) -> Context<'b> {
        Context {
            series: balances,
            facts: self.facts,
            basis: self.basis,
            frequency: if self.frequency == "annual" {
                "annual"
            } else {
                "quarterly"
            },
            period,
            entity: self.entity,
        }
    }
    fn roic(&self, balances: &[Series]) -> Observation {
        let b = self.b("return_on_invested_capital", "nopat");
        let formula = "NOPAT / average(invested_capital)";
        if self.entity == "financial" {
            return not_applicable(
                b,
                formula,
                "financial_company_return_on_invested_capital_not_applicable",
            );
        }
        let prior = prior_comparable_period(
            self.period,
            if self.frequency == "annual" {
                "annual"
            } else {
                "quarterly"
            },
            if self.frequency == "annual" { 1 } else { 4 },
        );
        let current = self
            .balance_context(balances, self.period)
            .invested_capital();
        let previous = self.balance_context(balances, &prior).invested_capital();
        let points = [
            Some(as_point(&self.nopat())),
            Some(as_point(&current)),
            Some(as_point(&previous)),
        ];
        if let Some(unavailable) = unavailable_points(
            &b,
            &points,
            &["numerator", "current_balance", "prior_balance"],
        ) {
            return formatted(unavailable, formula, "percent");
        }
        average_balance(b, formula, &points)
    }
    fn incremental_roic(&self, balances: &[Series]) -> Observation {
        let b = self.b("incremental_roic", "nopat");
        let formula = "ΔNOPAT / Δinvested_capital";
        if self.entity == "financial" {
            return not_applicable(
                b,
                formula,
                "financial_company_incremental_roic_not_applicable",
            );
        }
        let prior = prior_comparable_period(
            self.period,
            if self.frequency == "annual" {
                "annual"
            } else {
                "quarterly"
            },
            if self.frequency == "annual" { 1 } else { 4 },
        );
        let previous_nopat = self.at(&prior).nopat();
        let current_capital = self
            .balance_context(balances, self.period)
            .invested_capital();
        let previous_capital = self.balance_context(balances, &prior).invested_capital();
        let points = [
            Some(as_point(&self.nopat())),
            Some(as_point(&previous_nopat)),
            Some(as_point(&current_capital)),
            Some(as_point(&previous_capital)),
        ];
        if let Some(unavailable) = unavailable_points(
            &b,
            &points,
            &[
                "nopat",
                "prior_nopat",
                "invested_capital",
                "prior_invested_capital",
            ],
        ) {
            return formatted(unavailable, formula, "percent");
        }
        let change = val(&points[2]) - val(&points[3]);
        if change <= 0.0 {
            return unusable(
                b,
                "not_applicable",
                "non_positive_incremental_invested_capital",
                formula,
                "percent",
                &points,
            );
        }
        available(
            b,
            (val(&points[0]) - val(&points[1])) / change * 100.0,
            formula,
            "percent",
            &points,
        )
    }
}

fn val(point: &Option<Point>) -> f64 {
    point
        .as_ref()
        .and_then(|p| p.value)
        .expect("only usable inputs reach arithmetic")
}
fn input_refs(points: &[Option<Point>]) -> Vec<InputRef> {
    dedupe_refs(
        points
            .iter()
            .flatten()
            .flat_map(|p| p.inputs.clone())
            .collect(),
    )
}
fn formatted(mut observation: Observation, formula: &str, unit: &str) -> Observation {
    observation.formula = formula.into();
    observation.unit = unit.into();
    observation
}
fn available(
    mut observation: Observation,
    value: f64,
    formula: &str,
    unit: &str,
    points: &[Option<Point>],
) -> Observation {
    observation.status = "available".into();
    observation.value = Some(value);
    observation.reason_codes.clear();
    observation.inputs = input_refs(points);
    formatted(observation, formula, unit)
}
fn unusable(
    mut observation: Observation,
    status: &str,
    reason: &str,
    formula: &str,
    unit: &str,
    points: &[Option<Point>],
) -> Observation {
    observation.status = status.into();
    observation.value = None;
    observation.reason_codes = vec![reason.into()];
    observation.inputs = input_refs(points);
    formatted(observation, formula, unit)
}
fn not_applicable(observation: Observation, formula: &str, reason: &str) -> Observation {
    unusable(observation, "not_applicable", reason, formula, "", &[])
}

fn unavailable_inputs(
    b: &Observation,
    facts: &[Fact],
    metrics: &[&str],
    period: &Period,
    basis: &Basis,
    points: &[Option<Point>],
) -> Option<Observation> {
    let defined: Vec<_> = points.iter().flatten().collect();
    let inputs = input_refs(points);
    if defined.iter().any(|p| p.status == "incomparable") {
        let mut observation = b.clone();
        observation.status = "incomparable".into();
        observation.value = None;
        observation.inputs = inputs;
        observation.reason_codes = dedupe_strings(
            defined
                .iter()
                .flat_map(|p| p.reason_codes.clone())
                .collect(),
        );
        return Some(observation);
    }
    let index = metrics
        .iter()
        .enumerate()
        .find(|(i, _)| points[*i].as_ref().is_none_or(|p| p.status != "available"))
        .map(|(i, _)| i)?;
    let metric = metrics[index];
    let other = metric != "free_cash_flow"
        && facts.iter().any(|f| {
            f.metric == metric
                && period_key(&f.period) == period_key(period)
                && basis_key(&f.basis) != basis_key(basis)
                && f.value.is_some()
        });
    let reason = if other {
        "required_fact_has_different_basis".into()
    } else {
        format!("missing_{metric}")
    };
    let mut observation = b.clone();
    observation.status = if other { "incomparable" } else { "missing" }.into();
    observation.value = None;
    observation.reason_codes = vec![reason];
    observation.inputs = inputs;
    Some(observation)
}
fn unavailable_points(
    b: &Observation,
    points: &[Option<Point>],
    labels: &[&str],
) -> Option<Observation> {
    let defined: Vec<_> = points.iter().flatten().collect();
    let inputs = input_refs(points);
    if defined.iter().any(|p| p.status == "incomparable") {
        let mut observation = b.clone();
        observation.status = "incomparable".into();
        observation.value = None;
        observation.inputs = inputs;
        observation.reason_codes = dedupe_strings(
            defined
                .iter()
                .flat_map(|p| p.reason_codes.clone())
                .collect(),
        );
        return Some(observation);
    }
    let index = points
        .iter()
        .position(|p| p.as_ref().is_none_or(|p| p.status != "available"))?;
    let point = &points[index];
    let mut observation = b.clone();
    observation.status = if point.as_ref().is_some_and(|p| p.status == "not_applicable") {
        "not_applicable"
    } else {
        "missing"
    }
    .into();
    observation.value = None;
    observation.reason_codes = point
        .as_ref()
        .filter(|p| !p.reason_codes.is_empty())
        .map(|p| p.reason_codes.clone())
        .unwrap_or_else(|| vec![format!("missing_{}", labels[index])]);
    observation.inputs = inputs;
    Some(observation)
}
fn combine_points(
    b: &Observation,
    formula: &str,
    points: &[Option<Point>],
    labels: &[&str],
) -> Point {
    if let Some(unavailable) = unavailable_points(b, points, labels) {
        return Point {
            period: b.period.clone(),
            status: unavailable.status,
            value: None,
            formula: formula.into(),
            reason_codes: unavailable.reason_codes,
            inputs: unavailable.inputs,
        };
    }
    Point {
        period: b.period.clone(),
        status: "available".into(),
        value: Some(points.iter().map(val).sum()),
        formula: formula.into(),
        reason_codes: vec![],
        inputs: input_refs(points),
    }
}
fn divide_points(
    b: Observation,
    formula: &str,
    unit: &str,
    multiplier: f64,
    points: &[Option<Point>],
    labels: &[&str],
) -> Observation {
    if let Some(unavailable) = unavailable_points(&b, points, labels) {
        return formatted(unavailable, formula, unit);
    }
    if val(&points[1]) == 0.0 {
        return unusable(
            b,
            "not_applicable",
            "zero_denominator",
            formula,
            unit,
            points,
        );
    }
    available(
        b,
        val(&points[0]) / val(&points[1]) * multiplier,
        formula,
        unit,
        points,
    )
}
fn average_balance(b: Observation, formula: &str, points: &[Option<Point>]) -> Observation {
    let average = (val(&points[1]) + val(&points[2])) / 2.0;
    if average <= 0.0 {
        return unusable(
            b,
            "not_applicable",
            "non_positive_average_balance",
            formula,
            "percent",
            points,
        );
    }
    available(
        b,
        val(&points[0]) / average * 100.0,
        formula,
        "percent",
        points,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    fn fact(metric: &str, year: i32, value: Option<f64>) -> Value {
        let id = format!("{metric}:{year}");
        json!({"id":id,"metric":metric,"value":value,
            "period":{"kind":"annual","startDate":format!("{year}-01-01"),"endDate":format!("{year}-12-31"),"fiscalYear":year},
            "basis":{"id":"reported:CNY","currency":"CNY","accountingStandard":"CAS","scope":"consolidated","revision":"reported"},
            "provenance":{"sourceId":format!("source:{id}"),"sourceType":"eastmoney","locator":metric}})
    }
    fn full_facts() -> Vec<Value> {
        let metrics = [
            ("revenue", 1000.0),
            ("gross_profit", 400.0),
            ("operating_profit", 160.0),
            ("net_profit", 100.0),
            ("operating_cash_flow", 140.0),
            ("capital_expenditure", 50.0),
            ("cost_of_revenue", 600.0),
            ("cash", 400.0),
            ("total_debt", 700.0),
            ("total_equity", 2000.0),
            ("total_assets", 4000.0),
            ("current_assets", 1800.0),
            ("current_liabilities", 600.0),
            ("trade_receivables", 250.0),
            ("contract_assets", 20.0),
            ("inventory", 180.0),
            ("trade_payables", 160.0),
            ("interest_expense", 20.0),
            ("pre_tax_profit", 140.0),
            ("income_tax_expense", 35.0),
            ("dividends_paid", 40.0),
            ("share_repurchases", 30.0),
            ("share_issuance", 10.0),
            ("diluted_weighted_average_shares", 100.0),
            ("diluted_shares", 100.0),
        ];
        [2024, 2025]
            .into_iter()
            .flat_map(|year| {
                metrics.iter().map(move |(metric, value)| {
                    fact(
                        metric,
                        year,
                        Some(value * if year == 2025 { 1.1 } else { 1.0 }),
                    )
                })
            })
            .collect()
    }
    fn quality(facts: &[Value], entity: &str) -> Value {
        super::super::try_build(facts, entity).unwrap()
    }
    fn observation<'a>(quality: &'a Value, kind: &str, year: i32) -> &'a Value {
        quality["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| {
                item["kind"] == kind
                    && item["frequency"] == "annual"
                    && item["period"]["fiscalYear"] == year
            })
            .unwrap()
    }
    fn near(actual: &Value, expected: f64) {
        assert!(
            (actual.as_f64().unwrap() - expected).abs() < 1e-10,
            "actual={actual},expected={expected}"
        );
    }

    #[test]
    fn cash_profit_shares_and_distributions_keep_reported_units() {
        let q = quality(&full_facts(), "non_financial");
        near(&observation(&q, "free_cash_flow", 2025)["value"], 99.0);
        near(
            &observation(&q, "free_cash_flow_per_share", 2025)["value"],
            0.9,
        );
        near(&observation(&q, "net_profit_per_share", 2025)["value"], 1.0);
        near(
            &observation(&q, "shareholder_distributions", 2025)["value"],
            77.0,
        );
        near(
            &observation(&q, "net_equity_distribution", 2025)["value"],
            66.0,
        );
        near(&observation(&q, "working_capital", 2025)["value"], 319.0);
        near(
            &observation(&q, "quick_ratio", 2025)["value"],
            737.0 / 660.0,
        );
        assert_eq!(observation(&q, "free_cash_flow", 2025)["unit"], "CNY");
        assert_eq!(
            observation(&q, "free_cash_flow_per_share", 2025)["unit"],
            "CNY/share"
        );
        assert_eq!(
            observation(&q, "free_cash_flow", 2025)["inputs"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn return_ratios_use_prior_average_balances_not_ending_balances() {
        let q = quality(&full_facts(), "non_financial");
        near(
            &observation(&q, "return_on_equity", 2025)["value"],
            110.0 / 2100.0 * 100.0,
        );
        near(
            &observation(&q, "return_on_assets", 2025)["value"],
            110.0 / 4200.0 * 100.0,
        );
        near(
            &observation(&q, "return_on_invested_capital", 2025)["value"],
            132.0 / 2415.0 * 100.0,
        );
        near(
            &observation(&q, "incremental_roic", 2025)["value"],
            12.0 / 230.0 * 100.0,
        );
        assert_eq!(
            observation(&q, "return_on_equity", 2024)["status"],
            "missing"
        );
        near(&observation(&q, "net_dilution_rate", 2025)["value"], 10.0);
    }

    #[test]
    fn turnover_uses_actual_period_days_and_average_current_and_prior() {
        let q = quality(&full_facts(), "non_financial");
        let dso = 283.5 / 1100.0 * 365.0;
        let dio = 189.0 / 660.0 * 365.0;
        let dpo = 168.0 / 660.0 * 365.0;
        near(
            &observation(&q, "days_sales_outstanding", 2025)["value"],
            dso,
        );
        near(
            &observation(&q, "days_inventory_outstanding", 2025)["value"],
            dio,
        );
        near(
            &observation(&q, "days_payables_outstanding", 2025)["value"],
            dpo,
        );
        near(
            &observation(&q, "cash_conversion_cycle", 2025)["value"],
            dso + dio - dpo,
        );
        assert_eq!(
            observation(&q, "days_sales_outstanding", 2024)["status"],
            "missing"
        );
    }

    #[test]
    fn unknown_profile_preserves_fcf_arithmetic_but_blocks_entity_assumptions() {
        let q = quality(&full_facts(), "unknown");
        near(&observation(&q, "free_cash_flow", 2025)["value"], 99.0);
        near(&observation(&q, "gross_margin", 2025)["value"], 40.0);
        for kind in [
            "free_cash_flow_margin",
            "cash_conversion",
            "free_cash_flow_per_share",
            "working_capital",
            "nopat",
            "return_on_assets",
            "return_on_invested_capital",
        ] {
            let o = observation(&q, kind, 2025);
            assert_eq!(o["status"], "missing");
            assert!(o["value"].is_null());
            assert_eq!(
                o["reasonCodes"],
                json!(["entity_financial_profile_unconfirmed"])
            );
            assert_eq!(o["inputs"], json!([]));
        }
    }

    #[test]
    fn confirmed_financial_entities_do_not_receive_industrial_metrics() {
        let q = quality(&full_facts(), "financial");
        for kind in [
            "free_cash_flow",
            "cash_conversion",
            "free_cash_flow_per_share",
            "working_capital",
            "current_ratio",
            "nopat",
            "return_on_assets",
            "return_on_invested_capital",
        ] {
            let o = observation(&q, kind, 2025);
            assert_eq!(o["status"], "not_applicable");
            assert!(o["value"].is_null());
        }
        assert_eq!(
            observation(&q, "return_on_equity", 2025)["status"],
            "available"
        );
        assert_eq!(observation(&q, "net_debt", 2025)["status"], "available");
    }

    #[test]
    fn zero_and_negative_denominators_are_not_fabricated_ratios() {
        let mut facts = full_facts();
        for f in &mut facts {
            if f["period"]["fiscalYear"] == 2025
                && [
                    "net_profit",
                    "revenue",
                    "diluted_weighted_average_shares",
                    "diluted_shares",
                ]
                .contains(&f["metric"].as_str().unwrap())
            {
                f["value"] = json!(0);
            }
        }
        let q = quality(&facts, "non_financial");
        assert_eq!(
            observation(&q, "gross_margin", 2025)["reasonCodes"],
            json!(["zero_denominator"])
        );
        assert_eq!(
            observation(&q, "cash_conversion", 2025)["reasonCodes"],
            json!(["non_positive_profit_denominator"])
        );
        assert_eq!(
            observation(&q, "net_profit_per_share", 2025)["reasonCodes"],
            json!(["non_positive_share_denominator"])
        );
    }

    #[test]
    fn missing_metric_and_different_basis_remain_distinct() {
        let mut facts = full_facts();
        facts.retain(|f| {
            !(f["metric"] == "capital_expenditure" && f["period"]["fiscalYear"] == 2025)
        });
        let q = quality(&facts, "non_financial");
        assert_eq!(observation(&q, "free_cash_flow", 2025)["status"], "missing");
        assert_eq!(
            observation(&q, "free_cash_flow", 2025)["reasonCodes"],
            json!(["missing_capital_expenditure"])
        );
        let mut foreign = fact("capital_expenditure", 2025, Some(20.0));
        foreign["basis"]["currency"] = json!("USD");
        foreign["basis"]["id"] = json!("reported:USD");
        facts.push(foreign);
        let q = quality(&facts, "non_financial");
        let o = q["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| {
                o["kind"] == "free_cash_flow"
                    && o["basis"]["currency"] == "CNY"
                    && o["period"]["fiscalYear"] == 2025
            })
            .unwrap();
        assert_eq!(o["status"], "incomparable");
        assert_eq!(
            o["reasonCodes"],
            json!(["required_fact_has_different_basis"])
        );
    }

    #[test]
    fn failed_bridge_and_its_original_input_lineage_survive_derived_ratios() {
        let mut facts = full_facts();
        let f = facts
            .iter_mut()
            .find(|f| f["metric"] == "gross_profit" && f["period"]["fiscalYear"] == 2025)
            .unwrap();
        f["value"] = Value::Null;
        f["derivationStatus"] = json!("incomparable");
        f["derivationReasonCodes"] = json!(["bridge_basis_changed"]);
        f["inputReferences"] = json!([{"factId":"original-cumulative","provenance":{"sourceId":"original","sourceType":"eastmoney"}}]);
        let q = quality(&facts, "non_financial");
        let o = observation(&q, "gross_margin", 2025);
        assert_eq!(o["status"], "incomparable");
        assert_eq!(o["reasonCodes"], json!(["bridge_basis_changed"]));
        assert!(
            o["inputs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["factId"] == "original-cumulative")
        );
    }
}
