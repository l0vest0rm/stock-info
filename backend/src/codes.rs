use regex::Regex;

fn matches(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).unwrap().is_match(value)
}

pub fn normalize(input: &str) -> String {
    let raw = input.trim().to_uppercase();
    let korea = Regex::new(r"^(\d{6})(KS|KQ)(?:\.(?:SH|SZ))?$").unwrap();
    if let Some(captures) = korea.captures(&raw) {
        return format!("{}.{}", &captures[1], &captures[2]);
    }
    if raw.contains('.') {
        return raw;
    }
    if matches(r"^\d{6}$", &raw) {
        if raw.starts_with(['5', '6', '9']) {
            return format!("{raw}.SH");
        }
        if raw.starts_with(['0', '1', '2', '3']) {
            return format!("{raw}.SZ");
        }
    }
    if matches(r"^\d{5}$", &raw) {
        return format!("{raw}.HK");
    }
    raw
}

pub fn supported_company(input: &str) -> bool {
    matches(
        r"^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK|[A-Z0-9.-]+\.US)$",
        &normalize(input),
    )
}

pub fn supported(input: &str) -> bool {
    let code = normalize(input);
    supported_company(&code)
        || matches(r"^\d{6}\.(?:OF|SF|ZF|KS|KQ)$", &code)
        || code == "KS11.UI"
        || code == "HSI.HK"
}

pub fn normalize_company(input: &str) -> String {
    let raw = input.trim().to_uppercase();
    for pattern in [
        r"^US([A-Z0-9.-]+)\.(?:OQ|NQ|N|AMEX|PK|OB)$",
        r"^(SH|SZ|BJ)(\d{6})$",
        r"^HK(\d{5})$",
    ] {
        if let Some(caps) = Regex::new(pattern).unwrap().captures(&raw) {
            return if pattern.starts_with("^US") {
                format!("{}.US", &caps[1])
            } else if pattern.starts_with("^HK") {
                format!("{}.HK", &caps[1])
            } else {
                format!("{}.{}", &caps[2], &caps[1])
            };
        }
    }
    let normalized = normalize(&raw);
    if supported_company(&normalized) {
        normalized
    } else {
        String::new()
    }
}

pub fn market(code: &str) -> &'static str {
    let normalized = normalize(code);
    match normalized.rsplit('.').next().unwrap_or("") {
        "SH" => "cn-sh",
        "SZ" => "cn-sz",
        "BJ" => "cn-bj",
        "HK" => "hk",
        "US" => "us",
        "OF" => "fund",
        "UI" if normalized == "KS11.UI" => "kr",
        _ => "global",
    }
}

pub fn security_type(code: &str) -> &'static str {
    let normalized = normalize(code);
    if normalized.ends_with(".OF")
        || normalized.ends_with(".SF")
        || normalized.ends_with(".ZF")
        || (matches(r"^\d{6}\.(?:SH|SZ|BJ)$", &normalized) && normalized.starts_with(['5', '1']))
    {
        "fund"
    } else {
        "stock"
    }
}

pub fn eastmoney_secid(code: &str) -> Option<String> {
    let normalized = normalize(code);
    if matches!(normalized.as_str(), "SPX.US" | "HSI.HK" | "KS11.UI") {
        return Some(format!("100.{}", normalized.split('.').next()?));
    }
    let (base, suffix) = normalized.rsplit_once('.')?;
    let prefix = match suffix {
        "SH" => "1",
        "SZ" | "BJ" => "0",
        "HK" => "116",
        "US" => "105",
        _ => return None,
    };
    Some(format!("{prefix}.{base}"))
}

pub fn xueqiu_symbol(code: &str) -> Option<String> {
    let normalized = normalize(code);
    let (base, suffix) = normalized.rsplit_once('.')?;
    Some(match suffix {
        "SH" | "SF" => format!("SH{base}"),
        "SZ" | "ZF" => format!("SZ{base}"),
        "BJ" => format!("BJ{base}"),
        "HK" => format!("{base:0>5}"),
        "US" | "O" | "N" | "AF" => base.to_string(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn security_identity_and_source_boundaries() {
        for (input, output) in [
            ("600036", "600036.SH"),
            ("00700", "00700.HK"),
            ("005930KS.SH", "005930.KS"),
            (" aapl.us ", "AAPL.US"),
        ] {
            assert_eq!(normalize(input), output);
        }
        assert_eq!(normalize_company("USNVDA.OQ"), "NVDA.US");
        assert_eq!(normalize_company("BJ430047"), "430047.BJ");
        assert_eq!(xueqiu_symbol("588000.SH"), Some("SH588000".into()));
        assert_eq!(xueqiu_symbol("019785.OF"), None);
        assert!(!supported_company("019785.OF"));
        assert!(supported("019785.OF"));
        assert!(!supported("../../private"));
    }
}
