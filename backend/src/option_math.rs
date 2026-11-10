//! Pure option pricing math. No IO, no providers, no SQLite.
//!
//! This module is shared by the `--analysis-json` stateless bridge and by the
//! SSE option analysis route. Keeping it free of IO lets offline scripts audit
//! the exact numbers the page shows. It is deliberately dependency-free:
//! Black-Scholes with a continuous dividend yield, and a bracketing
//! bisection inverse for implied volatility.
//!
//! Conventions:
//! - `time_to_expiry` is measured in years (calendar days / 365).
//! - `rate` and `dividend_yield` are continuous, e.g. `0.015` for 1.5%.
//! - `volatility` is annualized, e.g. `0.45` for 45%.
//! - Greeks: `delta` per unit of underling, `gamma` per unit squared,
//!   `vega` per 1.00 change in volatility (multiply by 1/100 for a vol point),
//!   `theta` per year (divide by 365 for a calendar day).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OptionKind {
    Call,
    Put,
}

impl OptionKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "C" | "CALL" => Some(Self::Call),
            "P" | "PUT" => Some(Self::Put),
            _ => None,
        }
    }
    pub fn as_code(self) -> &'static str {
        match self {
            Self::Call => "C",
            Self::Put => "P",
        }
    }
}

/// Complementary error function, max relative error 1.2e-7 (Numerical
/// Recipes `erfcc`, Chebyshev fit of W. J. Cody). Option quotes carry at most
/// six significant digits, so valuations are exact to quote precision while
/// the crate stays free of a numerics dependency.
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.5 * z);
    let poly = -1.265_512_23
        + t * (1.000_023_68
            + t * (0.374_091_96
                + t * (0.096_784_18
                    + t * (-0.186_288_06
                        + t * (0.278_868_07
                            + t * (-1.135_203_98
                                + t * (1.488_515_87 + t * (-0.822_152_23 + t * 0.170_872_77))))))));
    let value = t * (-z * z + poly).exp();
    if x >= 0.0 { value } else { 2.0 - value }
}

fn erf(x: f64) -> f64 {
    1.0 - erfc(x)
}

/// Normal CDF: P(Z <= x).
fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / std::f64::consts::SQRT_2))
}

/// Option sensitivities. `vega` is per 1.00 of volatility (divide by 100 for a
/// vol point); `theta` and `rho` are per year (divide theta by 365 per day).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Greeks {
    pub price: f64,
    pub delta: f64,
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64,
    pub rho: f64,
}

impl Greeks {
    pub fn zero() -> Self {
        Self {
            price: 0.0,
            delta: 0.0,
            gamma: 0.0,
            vega: 0.0,
            theta: 0.0,
            rho: 0.0,
        }
    }
}

/// Black-Scholes-Merton price and greeks with a continuous dividend yield.
pub fn black_scholes(
    kind: OptionKind,
    spot: f64,
    strike: f64,
    time_to_expiry: f64,
    rate: f64,
    dividend_yield: f64,
    volatility: f64,
) -> Greeks {
    let valid = [
        spot,
        strike,
        time_to_expiry,
        rate,
        dividend_yield,
        volatility,
    ]
    .iter()
    .all(|n| n.is_finite());
    if !valid || spot <= 0.0 || strike <= 0.0 {
        return Greeks::zero();
    }
    if time_to_expiry <= 0.0 {
        return expiry_value(kind, spot, strike);
    }
    let sqrt_t = time_to_expiry.sqrt();
    let discount_r = (-rate * time_to_expiry).exp();
    let discount_q = (-dividend_yield * time_to_expiry).exp();
    if volatility <= 0.0 {
        // Deterministic forward value: vega/gamma are not observable here and
        // stay zero so callers never extrapolate them.
        let forward = spot * discount_q;
        let discounted = strike * discount_r;
        let intrinsic = match kind {
            OptionKind::Call => (forward - discounted).max(0.0),
            OptionKind::Put => (discounted - forward).max(0.0),
        };
        return Greeks {
            price: intrinsic,
            delta: match kind {
                OptionKind::Call => f64::from(forward > discounted),
                OptionKind::Put => -f64::from(discounted > forward),
            },
            ..Greeks::zero()
        };
    }
    let vol_sqrt_t = volatility * sqrt_t;
    let d1 = ((spot / strike).ln()
        + (rate - dividend_yield + 0.5 * volatility * volatility) * time_to_expiry)
        / vol_sqrt_t;
    let d2 = d1 - vol_sqrt_t;
    let pdf = (-0.5 * d1 * d1).exp() / (2.0 * std::f64::consts::PI).sqrt();
    let (price, delta, theta, rho) = match kind {
        OptionKind::Call => (
            spot * discount_q * norm_cdf(d1) - strike * discount_r * norm_cdf(d2),
            discount_q * norm_cdf(d1),
            -spot * discount_q * pdf * volatility / (2.0 * sqrt_t)
                - rate * strike * discount_r * norm_cdf(d2)
                + dividend_yield * spot * discount_q * norm_cdf(d1),
            strike * time_to_expiry * discount_r * norm_cdf(d2),
        ),
        OptionKind::Put => (
            strike * discount_r * norm_cdf(-d2) - spot * discount_q * norm_cdf(-d1),
            -discount_q * norm_cdf(-d1),
            -spot * discount_q * pdf * volatility / (2.0 * sqrt_t)
                + rate * strike * discount_r * norm_cdf(-d2)
                - dividend_yield * spot * discount_q * norm_cdf(-d1),
            -strike * time_to_expiry * discount_r * norm_cdf(-d2),
        ),
    };
    Greeks {
        price: price.max(0.0),
        delta,
        gamma: discount_q * pdf / (spot * vol_sqrt_t),
        vega: spot * discount_q * pdf * sqrt_t,
        theta,
        rho,
    }
}

/// Forward-based Black-Scholes: price = df * (F·N(d1) - K·N(d2)) for a call.
///
/// A-share ETF options trade at a forward below `spot·exp(rT)` because the ETF
/// pays dividends mid-life. Solving volatility on spot with a dividend yield of
/// zero silently converts that carry into a fake put skew (the 588000 board
/// shows put IV ~3.5 vol points above call IV at the same strike). Callers that
/// can observe put-call parity should pass the implied forward instead of
/// guessing a dividend yield.
pub fn black_scholes_forward(
    kind: OptionKind,
    forward: f64,
    strike: f64,
    time_to_expiry: f64,
    volatility: f64,
    discount_factor: f64,
) -> Greeks {
    if !(forward.is_finite()
        && strike.is_finite()
        && time_to_expiry.is_finite()
        && volatility.is_finite()
        && discount_factor.is_finite())
        || forward <= 0.0
        || strike <= 0.0
        || discount_factor <= 0.0
    {
        return Greeks::zero();
    }
    if time_to_expiry <= 0.0 {
        let intrinsic = match kind {
            OptionKind::Call => (forward - strike).max(0.0),
            OptionKind::Put => (strike - forward).max(0.0),
        };
        return Greeks {
            price: discount_factor * intrinsic,
            delta: match kind {
                OptionKind::Call => f64::from(forward > strike),
                OptionKind::Put => -f64::from(strike > forward),
            },
            ..Greeks::zero()
        };
    }
    if volatility <= 0.0 {
        let intrinsic = match kind {
            OptionKind::Call => (forward - strike).max(0.0),
            OptionKind::Put => (strike - forward).max(0.0),
        };
        return Greeks {
            price: discount_factor * intrinsic,
            delta: match kind {
                OptionKind::Call => f64::from(forward > strike),
                OptionKind::Put => -f64::from(strike > forward),
            },
            ..Greeks::zero()
        };
    }
    let sqrt_t = time_to_expiry.sqrt();
    let vol_sqrt_t = volatility * sqrt_t;
    let d1 =
        ((forward / strike).ln() + 0.5 * volatility * volatility * time_to_expiry) / vol_sqrt_t;
    let d2 = d1 - vol_sqrt_t;
    let pdf = (-0.5 * d1 * d1).exp() / (2.0 * std::f64::consts::PI).sqrt();
    let (price, delta, theta, rho) = match kind {
        OptionKind::Call => (
            discount_factor * (forward * norm_cdf(d1) - strike * norm_cdf(d2)),
            norm_cdf(d1),
            // Forward-space theta: decay of forward value plus discount carry.
            -discount_factor * forward * pdf * volatility / (2.0 * sqrt_t),
            0.0,
        ),
        OptionKind::Put => (
            discount_factor * (strike * norm_cdf(-d2) - forward * norm_cdf(-d1)),
            norm_cdf(d1) - 1.0,
            -discount_factor * forward * pdf * volatility / (2.0 * sqrt_t),
            0.0,
        ),
    };
    Greeks {
        price: price.max(0.0),
        delta,
        gamma: discount_factor * pdf / (forward * vol_sqrt_t),
        vega: discount_factor * forward * pdf * sqrt_t,
        theta,
        rho,
    }
}

/// Implied volatility from a forward quote; `None` outside arbitrage bounds.
pub fn implied_volatility_forward(
    kind: OptionKind,
    forward: f64,
    strike: f64,
    time_to_expiry: f64,
    discount_factor: f64,
    price: f64,
) -> Option<f64> {
    if !(price.is_finite() && price > 0.0)
        || !(forward.is_finite() && forward > 0.0)
        || !(discount_factor.is_finite() && discount_factor > 0.0)
        || time_to_expiry <= 0.0
    {
        return None;
    }
    let at = |vol: f64| {
        black_scholes_forward(kind, forward, strike, time_to_expiry, vol, discount_factor).price
    };
    let (mut lo, mut hi) = (0.005_f64, 4.0_f64);
    if at(lo) > price || at(hi) < price {
        return None;
    }
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if at(mid) < price {
            lo = mid;
        } else {
            hi = mid;
        }
        if hi - lo < 1e-10 {
            break;
        }
    }
    Some(0.5 * (lo + hi))
}

fn expiry_value(kind: OptionKind, spot: f64, strike: f64) -> Greeks {
    let intrinsic = match kind {
        OptionKind::Call => (spot - strike).max(0.0),
        OptionKind::Put => (strike - spot).max(0.0),
    };
    Greeks {
        price: intrinsic,
        delta: match kind {
            OptionKind::Call => f64::from(spot > strike),
            OptionKind::Put => -f64::from(spot < strike),
        },
        ..Greeks::zero()
    }
}

/// Bracket the implied volatility of a quoted price by bisection.
///
/// Returns `None` when the quote is at or below intrinsic value, above the
/// no-arbitrage upper bound, or not bracketed within `0.5%..400%` vol. Callers
/// must treat `None` as "insufficient evidence", never as zero volatility.
pub fn implied_volatility(
    kind: OptionKind,
    spot: f64,
    strike: f64,
    time_to_expiry: f64,
    rate: f64,
    dividend_yield: f64,
    price: f64,
) -> Option<f64> {
    if !(price.is_finite() && price > 0.0) || time_to_expiry <= 0.0 {
        return None;
    }
    let (low, high) = (0.005_f64, 4.0_f64);
    let at = |vol: f64| {
        black_scholes(
            kind,
            spot,
            strike,
            time_to_expiry,
            rate,
            dividend_yield,
            vol,
        )
        .price
    };
    let (mut lo, mut hi) = (low, high);
    if at(lo) > price || at(hi) < price {
        return None;
    }
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if at(mid) < price {
            lo = mid;
        } else {
            hi = mid;
        }
        if hi - lo < 1e-10 {
            break;
        }
    }
    Some(0.5 * (lo + hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64, context: &str) {
        // Tolerance reflects the 1.2e-7 erfc fit (Numerical Recipes `erfcc`);
        // reference values carry 10 decimals.
        assert!(
            (actual - expected).abs() <= 1e-6,
            "{context}: {actual} != {expected}"
        );
    }

    #[test]
    fn forward_pricing_removes_the_synthetic_put_skew() {
        // Real 588000 2612 quotes: at the same strike, pricing on spot with q=0
        // makes the put look ~3.5 vol points richer than the call. Pricing on
        // the parity-implied forward must close that gap.
        let t = 44.0 / 365.0;
        let discount = (-0.015_f64 * t).exp();
        let forward = 1.3223;
        for (strike, call_price, put_price) in [
            (1.25_f64, 0.1369_f64, 0.0645_f64),
            (1.30, 0.1091, 0.0873),
            (1.35, 0.0848, 0.1123),
        ] {
            let call_iv = implied_volatility_forward(
                OptionKind::Call,
                forward,
                strike,
                t,
                discount,
                call_price,
            )
            .unwrap();
            let put_iv = implied_volatility_forward(
                OptionKind::Put,
                forward,
                strike,
                t,
                discount,
                put_price,
            )
            .unwrap();
            assert!(
                (call_iv - put_iv).abs() < 0.005,
                "strike {strike}: call iv {call_iv} vs put iv {put_iv}"
            );
            // And the model reprices both quotes from the recovered volatility.
            let c = black_scholes_forward(OptionKind::Call, forward, strike, t, call_iv, discount);
            let p = black_scholes_forward(OptionKind::Put, forward, strike, t, put_iv, discount);
            assert!((c.price - call_price).abs() < 1e-4);
            assert!((p.price - put_price).abs() < 1e-4);
            // Put-call parity holds by construction on the forward surface.
            assert!((c.price - p.price - discount * (forward - strike)).abs() < 1e-3);
        }
    }

    #[test]
    fn matches_reference_library_at_the_money_values() {
        // S=K=100, r=5%, q=0, sigma=20%, T=1y. Expected values come from
        // independent reference implementations (scipy.stats.norm), frozen
        // here so the native code can never "agree with itself".
        let g = black_scholes(OptionKind::Call, 100.0, 100.0, 1.0, 0.05, 0.0, 0.20);
        assert_close(g.price, 10.450_583_572_2, "call price");
        assert_close(g.delta, 0.636_830_651_2, "call delta");
        assert_close(g.gamma, 0.018_762_017_3, "gamma");
        assert_close(g.vega, 37.524_034_691_7, "vega");
        let p = black_scholes(OptionKind::Put, 100.0, 100.0, 1.0, 0.05, 0.0, 0.20);
        assert_close(p.price, 5.573_526_022_3, "put price");
        assert_close(p.delta, -0.363_169_348_8, "put delta");
        // Put-call parity: C - P = S e^{-qT} - K e^{-rT}.
        assert_close(
            g.price - p.price,
            100.0 - 100.0 * (-0.05_f64).exp(),
            "parity",
        );
    }

    #[test]
    fn implied_volatility_inverts_pricing() {
        for (kind, strike) in [
            (OptionKind::Call, 90.0),
            (OptionKind::Call, 110.0),
            (OptionKind::Put, 90.0),
            (OptionKind::Put, 110.0),
        ] {
            for vol in [0.10, 0.45, 0.90] {
                let price = black_scholes(kind, 100.0, strike, 0.5, 0.015, 0.0, vol).price;
                let found = implied_volatility(kind, 100.0, strike, 0.5, 0.015, 0.0, price)
                    .expect("bracketed");
                assert_close(found, vol, "iv round trip");
            }
        }
    }

    #[test]
    fn unpriced_or_arbitrage_quotes_are_rejected() {
        // Below intrinsic: a 1.20 put with spot 1.326 must be worth > 0 but a
        // quote of 0 is not a volatility observation.
        assert!(implied_volatility(OptionKind::Put, 1.326, 1.20, 0.1, 0.015, 0.0, 0.0).is_none());
        // Above the no-arbitrage bound for a call.
        assert!(implied_volatility(OptionKind::Call, 1.326, 1.20, 0.1, 0.015, 0.0, 5.0).is_none());
        // Expired contracts have no implied volatility.
        assert!(implied_volatility(OptionKind::Call, 1.326, 1.20, 0.0, 0.015, 0.0, 0.01).is_none());
    }

    #[test]
    fn expiry_returns_intrinsic_value_only() {
        let g = black_scholes(OptionKind::Put, 1.326, 1.20, 0.0, 0.015, 0.0, 0.45);
        assert_close(g.price, 0.0, "otm put at expiry");
        assert_close(g.gamma, 0.0, "expiry gamma");
        let itm = black_scholes(OptionKind::Put, 1.10, 1.20, 0.0, 0.015, 0.0, 0.45);
        assert_close(itm.price, 0.1, "itm put at expiry");
        assert_close(itm.delta, -1.0, "itm put delta");
    }

    #[test]
    fn theta_vega_scaling_is_documented_consistently() {
        let g = black_scholes(OptionKind::Put, 1.326, 1.20, 44.0 / 365.0, 0.015, 0.0, 0.47);
        // Short-dated put theta must be negative for the holder.
        assert!(g.theta < 0.0, "put theta {0}", g.theta);
        // Vega is positive and finite.
        assert!(g.vega > 0.0 && g.vega.is_finite(), "put vega {}", g.vega);
        // Delta stays inside its (-1, 0) band for a put.
        assert!(g.delta < 0.0 && g.delta > -1.0, "put delta {}", g.delta);
    }
}
