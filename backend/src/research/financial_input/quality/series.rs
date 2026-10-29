//! Source normalization, rolling TTM construction and time-series changes.
//! Keep the source-point and missing-history states observable: absent facts
//! are never replaced by zero, nor may incompatible accounting bases merge.
use super::*;
use std::collections::HashMap;

pub(super) fn normalized(facts: &[Fact]) -> Vec<Series> {
    // JavaScript Map preserves first insertion order; a BTreeMap would reorder
    // facts and change the report lineage even though its values were equal.
    let mut groups: Vec<Vec<&Fact>> = Vec::new();
    let mut positions = HashMap::<String, usize>::new();
    for fact in facts {
        let frequency = if fact.period.kind == "annual" {
            "annual"
        } else {
            "quarterly"
        };
        let key = format!("{}|{}|{frequency}", basis_key(&fact.basis), fact.metric);
        let index = *positions.entry(key).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[index].push(fact);
    }
    groups
        .into_iter()
        .map(|group| {
            let first = group[0];
            let mut periods: Vec<Vec<&Fact>> = Vec::new();
            let mut period_positions = HashMap::<String, usize>::new();
            for fact in &group {
                let index = *period_positions
                    .entry(period_key(&fact.period))
                    .or_insert_with(|| {
                        periods.push(Vec::new());
                        periods.len() - 1
                    });
                periods[index].push(fact);
            }
            let mut points: Vec<Point> = periods.into_iter().map(|p| source_point(&p)).collect();
            points.sort_by(|left, right| compare_period(&left.period, &right.period));
            Series {
                metric: first.metric.clone(),
                frequency: if first.period.kind == "annual" {
                    "annual".into()
                } else {
                    "quarterly".into()
                },
                basis: first.basis.clone(),
                unit: metric_unit(&first.metric, &first.basis),
                points,
            }
        })
        .collect()
}

fn source_point(facts: &[&Fact]) -> Point {
    let first = facts[0];
    let mut distinct = Vec::<f64>::new();
    for value in facts.iter().filter_map(|fact| fact.value) {
        if !distinct.contains(&value) {
            distinct.push(value);
        }
    }
    let inputs = facts
        .iter()
        .flat_map(|fact| match &fact.input_references {
            Some(references) if !references.is_empty() => references.clone(),
            _ => vec![InputRef {
                fact_id: fact.id.clone(),
                provenance: fact.provenance.clone(),
            }],
        })
        .collect();
    let mut point = Point {
        period: first.period.clone(),
        status: "available".into(),
        value: distinct.first().copied(),
        formula: first
            .derivation_formula
            .clone()
            .unwrap_or_else(|| "source fact".into()),
        reason_codes: Vec::new(),
        inputs,
    };
    if let Some(failed) = facts.iter().find(|fact| {
        fact.derivation_status
            .as_ref()
            .is_some_and(|status| !status.is_empty())
    }) {
        point.status = failed.derivation_status.clone().unwrap();
        point.value = None;
        point.formula = failed
            .derivation_formula
            .clone()
            .unwrap_or_else(|| "source fact".into());
        point.reason_codes = failed
            .derivation_reason_codes
            .clone()
            .unwrap_or_else(|| vec!["derived_fact_unavailable".into()]);
    } else if distinct.len() > 1 {
        point.status = "incomparable".into();
        point.value = None;
        point.reason_codes = vec!["conflicting_source_values".into()];
    } else if distinct.is_empty() {
        point.status = "missing".into();
        point.value = None;
        point.reason_codes = vec!["source_value_missing".into()];
    }
    point
}

pub(super) fn ttm(series: &[Series]) -> Vec<Series> {
    series
        .iter()
        .filter(|item| item.frequency == "quarterly" && aggregation(&item.metric) != "ending")
        .map(|item| {
            let mode = aggregation(&item.metric);
            let by_quarter: HashMap<i32, &Point> = item
                .points
                .iter()
                .map(|point| (quarter_index(&point.period), point))
                .collect();
            let points = item
                .points
                .iter()
                .map(|ending| {
                    let end = quarter_index(&ending.period);
                    let present: Vec<&Point> = (end - 3..=end)
                        .filter_map(|index| by_quarter.get(&index).copied())
                        .collect();
                    let mut period = ending.period.clone();
                    period.kind = "quarter".into();
                    if let Some(first) = present.first() {
                        period.start_date = first.period.start_date.clone();
                    }
                    let inputs = dedupe_refs(
                        present
                            .iter()
                            .flat_map(|point| point.inputs.clone())
                            .collect(),
                    );
                    if present.len() != 4 {
                        return Point {
                            period,
                            status: "missing".into(),
                            value: None,
                            formula: "four consecutive quarterly facts".into(),
                            reason_codes: vec!["insufficient_quarter_history".into()],
                            inputs,
                        };
                    }
                    let formula = if mode == "sum" {
                        "sum(last four quarters)"
                    } else {
                        "average(last four quarters)"
                    };
                    if let Some(unusable) = present.iter().find(|point| point.status != "available")
                    {
                        return Point {
                            period,
                            status: if unusable.status == "incomparable" {
                                "incomparable".into()
                            } else {
                                "missing".into()
                            },
                            value: None,
                            formula: formula.into(),
                            reason_codes: unusable.reason_codes.clone(),
                            inputs,
                        };
                    }
                    let sum: f64 = present.iter().map(|point| point.value.unwrap()).sum();
                    Point {
                        period,
                        status: "available".into(),
                        value: Some(if mode == "sum" { sum } else { sum / 4.0 }),
                        formula: formula.into(),
                        reason_codes: Vec::new(),
                        inputs,
                    }
                })
                .collect();
            Series {
                frequency: "ttm".into(),
                points,
                ..item.clone()
            }
        })
        .collect()
}

pub(super) fn trends(series: &Series) -> Vec<Observation> {
    let mut result = Vec::new();
    let by_index: HashMap<i32, &Point> = series
        .points
        .iter()
        .map(|point| (period_index(&point.period), point))
        .collect();
    for point in &series.points {
        let index = period_index(&point.period);
        if series.frequency == "annual" {
            if let Some(previous) = by_index.get(&(index - 1)) {
                result.push(change(series, "yoy", previous, point, 1));
            }
            continue;
        }
        if series.frequency == "quarterly"
            && let Some(previous) = by_index.get(&(index - 1))
        {
            result.push(change(series, "qoq", previous, point, 1));
        }
        if let Some(previous) = by_index.get(&(index - 4)) {
            result.push(change(series, "yoy", previous, point, 1));
        }
    }
    if series.frequency == "annual" {
        let available: Vec<&Point> = series
            .points
            .iter()
            .filter(|point| point.status == "available")
            .collect();
        if let (Some(first), Some(last)) = (available.first(), available.last()) {
            let years = last.period.fiscal_year - first.period.fiscal_year;
            if years > 1 {
                result.push(change(series, "cagr", first, last, years));
            }
        }
    }
    result
}

fn change(series: &Series, kind: &str, from: &Point, to: &Point, intervals: i32) -> Observation {
    let mut observation = base(
        kind,
        &series.metric,
        &series.basis,
        &series.frequency,
        &to.period,
    );
    observation.comparison_period = Some(from.period.clone());
    observation.inputs = dedupe_refs([from.inputs.clone(), to.inputs.clone()].concat());
    observation.unit = "percent".into();
    observation.formula = if kind == "cagr" {
        "(current / prior)^(1 / years) - 1".into()
    } else {
        "current / prior - 1".into()
    };
    if from.status != "available" || to.status != "available" {
        observation.status = if from.status == "incomparable" || to.status == "incomparable" {
            "incomparable".into()
        } else {
            "missing".into()
        };
        observation.value = None;
        observation.reason_codes =
            dedupe_strings([from.reason_codes.clone(), to.reason_codes.clone()].concat());
        return observation;
    }
    let previous = from.value.unwrap();
    let current = to.value.unwrap();
    if previous == 0.0 || (kind == "cagr" && (previous < 0.0 || current < 0.0)) {
        observation.status = "not_applicable".into();
        observation.value = None;
        observation.reason_codes = vec![if kind == "cagr" {
            "cagr_requires_positive_values".into()
        } else {
            "zero_comparison_denominator".into()
        }];
        return observation;
    }
    observation.status = "available".into();
    observation.value = Some(if kind == "cagr" {
        ((current / previous).powf(1.0 / f64::from(intervals)) - 1.0) * 100.0
    } else {
        (current / previous - 1.0) * 100.0
    });
    observation.reason_codes.clear();
    observation
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fact(id: &str, metric: &str, year: i32, quarter: u8, value: Option<f64>) -> Fact {
        let month = u32::from(quarter) * 3;
        serde_json::from_value(json!({
            "id":id,"metric":metric,"value":value,
            "period":{"kind":"quarter","startDate":format!("{year}-{:02}-01",month-2),"endDate":format!("{year}-{month:02}-{}",if quarter==1 || quarter==4 {31} else {30}),"fiscalYear":year,"fiscalQuarter":quarter},
            "basis":{"id":"reported","currency":"CNY","accountingStandard":"CAS","scope":"consolidated","revision":"reported"},
            "provenance":{"sourceId":format!("source-{id}"),"sourceType":"eastmoney"}
        })).unwrap()
    }

    #[test]
    fn source_conflicts_and_failed_bridges_remain_visible() {
        let first = fact("first", "revenue", 2026, 1, Some(10.0));
        let mut second = fact("second", "revenue", 2026, 1, Some(11.0));
        let series = normalized(&[first.clone(), second.clone()]);
        assert_eq!(series[0].points[0].status, "incomparable");
        assert_eq!(series[0].points[0].value, None);
        assert_eq!(series[0].points[0].inputs.len(), 2);
        second.derivation_status = Some("missing".into());
        second.derivation_reason_codes = Some(vec!["missing_predecessor".into()]);
        second.derivation_formula = Some("current cumulative - prior cumulative".into());
        let series = normalized(&[first, second]);
        let point = &series[0].points[0];
        assert_eq!(point.status, "missing");
        assert_eq!(point.reason_codes, ["missing_predecessor"]);
        assert_eq!(point.formula, "current cumulative - prior cumulative");
    }

    #[test]
    fn ttm_requires_four_consecutive_quarters_and_averages_share_counts() {
        let facts: Vec<Fact> = (1..=4)
            .flat_map(|quarter| {
                [
                    fact(
                        &format!("r{quarter}"),
                        "revenue",
                        2026,
                        quarter,
                        Some(f64::from(quarter) * 10.0),
                    ),
                    fact(
                        &format!("s{quarter}"),
                        "diluted_weighted_average_shares",
                        2026,
                        quarter,
                        Some(f64::from(quarter) * 100.0),
                    ),
                    fact(&format!("c{quarter}"), "cash", 2026, quarter, Some(1000.0)),
                ]
            })
            .collect();
        let generated = ttm(&normalized(&facts));
        assert_eq!(generated.len(), 2);
        let revenue = generated
            .iter()
            .find(|series| series.metric == "revenue")
            .unwrap();
        assert_eq!(revenue.points[0].status, "missing");
        assert_eq!(
            revenue.points[0].reason_codes,
            ["insufficient_quarter_history"]
        );
        assert_eq!(revenue.points[3].value, Some(100.0));
        assert_eq!(revenue.points[3].period.start_date, "2026-01-01");
        assert_eq!(revenue.points[3].inputs.len(), 4);
        let shares = generated
            .iter()
            .find(|series| series.metric == "diluted_weighted_average_shares")
            .unwrap();
        assert_eq!(shares.points[3].value, Some(250.0));
        assert_eq!(shares.points[3].formula, "average(last four quarters)");
        let with_gap = normalized(&[
            fact("r1", "revenue", 2026, 1, Some(1.0)),
            fact("r3", "revenue", 2026, 3, Some(3.0)),
            fact("r4", "revenue", 2026, 4, Some(4.0)),
            fact("r5", "revenue", 2027, 1, Some(5.0)),
        ]);
        assert_eq!(ttm(&with_gap)[0].points.last().unwrap().status, "missing");
    }

    #[test]
    fn trend_denominators_and_annual_cagr_preserve_states() {
        let facts = [
            fact("zero", "revenue", 2026, 1, Some(0.0)),
            fact("next", "revenue", 2026, 2, Some(10.0)),
        ];
        let changes = trends(&normalized(&facts)[0]);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].status, "not_applicable");
        assert_eq!(changes[0].reason_codes, ["zero_comparison_denominator"]);
        let mut annual: Vec<Fact> = [(2023, 100.0), (2024, 110.0), (2025, 121.0)]
            .into_iter()
            .map(|(year, value)| {
                let mut fact = fact(&year.to_string(), "revenue", year, 4, Some(value));
                fact.period.kind = "annual".into();
                fact.period.start_date = format!("{year}-01-01");
                fact.period.fiscal_quarter = None;
                fact
            })
            .collect();
        let changes = trends(&normalized(&annual)[0]);
        let cagr = changes
            .iter()
            .find(|observation| observation.kind == "cagr")
            .unwrap();
        assert!((cagr.value.unwrap() - 10.0).abs() < 1e-10);
        annual[0].value = Some(-100.0);
        let changes = trends(&normalized(&annual)[0]);
        assert_eq!(
            changes
                .iter()
                .find(|observation| observation.kind == "cagr")
                .unwrap()
                .status,
            "not_applicable"
        );
    }

    #[test]
    fn normalization_does_not_mix_accounting_bases() {
        let a = fact("a", "revenue", 2026, 1, Some(10.0));
        let mut b = fact("b", "revenue", 2026, 1, Some(20.0));
        b.basis.currency = "USD".into();
        let series = normalized(&[a, b]);
        assert_eq!(series.len(), 2);
        assert_eq!(series[0].unit, "CNY");
        assert_eq!(series[1].unit, "USD");
        assert!(
            series
                .iter()
                .all(|series| series.points[0].status == "available")
        );
    }
}
