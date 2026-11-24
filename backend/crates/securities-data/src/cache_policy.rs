use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::{
    America::New_York,
    Asia::{Hong_Kong, Shanghai},
    Tz,
};
use serde_json::Value;

pub fn market_ttl(code: &str, now_ms: i64) -> i64 {
    let code = crate::codes::normalize(code);
    match code.rsplit('.').next().unwrap_or("") {
        "SH" | "SZ" | "BJ" | "OF" => region_ttl("cn", now_ms),
        "HK" => region_ttl("hk", now_ms),
        "US" => region_ttl("us", now_ms),
        _ => 6 * 3_600_000,
    }
}

pub fn region_ttl(region: &str, now_ms: i64) -> i64 {
    let (tz, sessions): (Tz, &[(u32, u32)]) = match region {
        "cn" => (Shanghai, &[(570, 690), (780, 900)]),
        "hk" => (Hong_Kong, &[(570, 720), (780, 960)]),
        "us" => (New_York, &[(570, 960)]),
        _ => return 6 * 3_600_000,
    };
    let Some(utc) = DateTime::from_timestamp_millis(now_ms) else {
        return 60_000;
    };
    let local = utc.with_timezone(&tz);
    let minutes = local.hour() * 60 + local.minute();
    let weekday = |day| !matches!(day, Weekday::Sat | Weekday::Sun);
    if weekday(local.weekday())
        && sessions
            .iter()
            .any(|(start, end)| minutes >= *start && minutes < *end)
    {
        return 600_000;
    }
    for offset in 0..8 {
        let Some(date) = local
            .date_naive()
            .checked_add_signed(Duration::days(offset))
        else {
            break;
        };
        if !weekday(date.weekday()) {
            continue;
        }
        for (start, _) in sessions {
            if offset == 0 && *start <= minutes {
                continue;
            }
            if let Some(open) = tz
                .from_local_datetime(&date.and_hms_opt(start / 60, start % 60, 0).unwrap())
                .earliest()
            {
                return (open.timestamp_millis() - now_ms).max(60_000);
            }
        }
    }
    86_400_000
}

pub fn latest_completed_quarter(now_ms: i64) -> String {
    let local = DateTime::<Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_default()
        .with_timezone(&Shanghai);
    let start_month = ((local.month() - 1) / 3) * 3 + 1;
    NaiveDate::from_ymd_opt(local.year(), start_month, 1)
        .unwrap()
        .pred_opt()
        .unwrap()
        .to_string()
}

pub fn financial_ttl(rows: &[Value], now_ms: i64) -> i64 {
    if rows
        .first()
        .and_then(|r| r["reportDate"].as_str())
        .is_some_and(|d| d.get(..10) == Some(&latest_completed_quarter(now_ms)))
    {
        let local = DateTime::<Utc>::from_timestamp_millis(now_ms)
            .unwrap_or_default()
            .with_timezone(&Shanghai);
        let next = ((local.month() - 1) / 3) * 3 + 4;
        let (year, month) = if next > 12 {
            (local.year() + 1, next - 12)
        } else {
            (local.year(), next)
        };
        return (Shanghai
            .with_ymd_and_hms(year, month, 1, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis()
            - now_ms)
            .max(60_000);
    }
    86_400_000
}

pub fn financial_fresh(rows: &[Value], now_ms: i64) -> bool {
    let Some(first) = rows.first() else {
        return false;
    };
    if first["reportDate"]
        .as_str()
        .is_some_and(|d| d.get(..10) == Some(&latest_completed_quarter(now_ms)))
    {
        return true;
    }
    first["updatedAt"]
        .as_i64()
        .is_some_and(|updated| updated > 0 && now_ms - updated < 86_400_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trading_sessions_and_quarter_boundaries() {
        let now = DateTime::parse_from_rfc3339("2026-10-29T10:00:00+08:00")
            .unwrap()
            .timestamp_millis();
        assert_eq!(region_ttl("cn", now), 600_000);
        let lunch = DateTime::parse_from_rfc3339("2026-10-29T12:00:00+08:00")
            .unwrap()
            .timestamp_millis();
        assert_eq!(region_ttl("cn", lunch), 3_600_000);
        assert_eq!(latest_completed_quarter(now), "2026-09-30");
        assert!(financial_fresh(
            &[serde_json::json!({"reportDate":"2026-09-30","updatedAt":1})],
            now
        ));
        assert!(!financial_fresh(
            &[serde_json::json!({"reportDate":"2026-06-30","updatedAt":1})],
            now
        ));
        let winter = DateTime::parse_from_rfc3339("2026-12-01T14:30:00Z")
            .unwrap()
            .timestamp_millis();
        let summer = DateTime::parse_from_rfc3339("2026-07-01T13:30:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(region_ttl("us", winter), 600_000);
        assert_eq!(region_ttl("us", summer), 600_000);
    }
}
