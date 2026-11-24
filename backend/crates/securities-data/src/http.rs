use anyhow::{Result, bail};
use serde_json::Value;

pub fn parse_json_or_jsonp(text: &str) -> Result<Value> {
    let text = text.trim();
    if text.starts_with('{') || text.starts_with('[') {
        return Ok(serde_json::from_str(text)?);
    }
    if let (Some(start), Some(end)) = (text.find('('), text.rfind(')'))
        && end > start
    {
        return Ok(serde_json::from_str(&text[start + 1..end])?);
    }
    bail!("invalid provider JSON/JSONP payload")
}

pub fn number(value: &Value) -> Option<f64> {
    if let Some(raw) = value.get("raw") {
        return number(raw);
    }
    if value.is_null() || value.as_str() == Some("") {
        return None;
    }
    value
        .as_f64()
        .or_else(|| value.as_str()?.replace(',', "").parse().ok())
        .filter(|n| n.is_finite())
}

pub(crate) fn url_encoded_segment(value: &str) -> String {
    // encodeURIComponent semantics: encode slash and delimiter characters, not
    // form-urlencoded '+' spaces. The provider's IDs are normally ASCII AP….
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").unwrap();
        }
    }
    encoded
}
