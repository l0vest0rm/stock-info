//! Native materializers for reviewed valuation metadata and capture keywords.
//! They only write when the original command's explicit/default write policy
//! permits it; a check never changes either file.
use crate::{AppState, coverage};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::Write,
    path::Path,
};

fn read(path: &Path) -> Result<(Vec<u8>, Value)> {
    let bytes = fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    let value = serde_json::from_slice(&bytes)?;
    Ok((bytes, value))
}
fn replace(path: &Path, original: &[u8], value: &Value) -> Result<()> {
    if fs::read(path)? != original {
        bail!("configuration changed concurrently: {}", path.display());
    }
    let parent = path.parent().context("configuration has no parent")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged
        .as_file()
        .set_permissions(fs::metadata(path)?.permissions())?;
    let mut body = serde_json::to_vec_pretty(value)?;
    body.push(b'\n');
    staged.write_all(&body)?;
    staged.as_file().sync_all()?;
    // Avoid silently replacing a concurrent edit while serializing the output.
    if fs::read(path)? != original {
        bail!("configuration changed concurrently: {}", path.display());
    }
    staged.persist(path).map_err(|error| error.error)?;
    Ok(())
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn valid_date(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}
fn materialize(data: &mut Value, derived: &Value) -> (bool, BTreeSet<String>) {
    let by_id: HashMap<&str, &Value> = array(&derived["companies"])
        .iter()
        .map(|c| (text(&c["companyId"]), c))
        .collect();
    let mut changed = false;
    let mut drift = BTreeSet::new();
    let Some(companies) = data["companies"].as_array_mut() else {
        return (false, drift);
    };
    for company in companies {
        let id = text(&company["id"]).to_owned();
        let Some(derived) = by_id.get(id.as_str()) else {
            drift.insert(format!("{id}: 缺少估值覆盖"));
            continue;
        };
        let mut factors: Vec<Value> = array(&derived["factors"])
            .iter()
            .map(|f| json!({"factor":f["factor"],"weight":f["weight"],"direction":f["direction"]}))
            .collect();
        factors.sort_by(|a, b| text(&a["factor"]).cmp(text(&b["factor"])));
        let mut tags: Vec<Value> = array(&derived["factors"])
            .iter()
            .map(|f| f["label"].clone())
            .chain(array(&company["themeTags"]).iter().cloned())
            .collect();
        tags.sort_by(|a, b| text(a).encode_utf16().cmp(text(b).encode_utf16()));
        tags.dedup();
        let latest = array(&company["evidenceRefs"])
            .iter()
            .filter(|r| r["kind"] == "primary" && valid_date(text(&r["publishedAt"])))
            .map(|r| text(&r["publishedAt"]))
            .max()
            .map(|d| json!(d))
            .unwrap_or(Value::Null);
        for (key, value, report) in [
            ("factorExposures", json!(factors), true),
            (
                "valuationArchetype",
                derived["valuationProfile"]["archetype"].clone(),
                true,
            ),
            (
                "researchPriority",
                derived["researchTier"]["priority"].clone(),
                true,
            ),
            (
                "watchStatus",
                derived["researchTier"]["watchStatus"].clone(),
                true,
            ),
            (
                "researchBasis",
                derived["researchTier"]["basis"].clone(),
                false,
            ),
            ("themeTags", json!(tags), false),
            ("lastEvidenceDate", latest, true),
        ] {
            if company.get(key) != Some(&value) {
                company[key] = value;
                changed = true;
                if report {
                    drift.insert(format!("{id}.{key}"));
                }
            }
        }
    }
    (changed, drift)
}
fn valuation(state: &AppState, options: &Value) -> Result<Value> {
    let path = state.root.join("config/investment-universe.json");
    let (bytes, mut data) = read(&path)?;
    let industry =
        state.config("config/research/research-eastmoney-em2016-industry-profiles.json")?;
    let company = state.config("config/generated/eastmoney-company-em2016-profiles.json")?;
    let derived = coverage::build(&data, &industry, &company);
    let (changed, drift) = materialize(&mut data, &derived);
    let write = options["write"] == true;
    if changed && write {
        replace(&path, &bytes, &data)?;
    }
    let channels: Vec<Value> = array(&derived["rateSensitivity"]["channels"]).iter().map(|c|json!({"channel":c["channel"],"direction":c["direction"],"companies":array(&c["companies"]).len()})).collect();
    let summary = json!({"companies":derived["companyCount"],"archetypeCounts":derived["archetypeCounts"],"topFactors":array(&derived["topFactors"]).iter().take(6).collect::<Vec<_>>(),"rateChannels":channels,"rateUnresolved":derived["rateSensitivity"]["unresolved"],"driftItems":drift.len(),"mode":if write {"write"}else{"check"}});
    if !write && !drift.is_empty() {
        bail!("Drift detected. Run sync:investment-universe:valuation: {summary}");
    }
    Ok(summary)
}
fn names(payload: &Value) -> Result<Vec<String>> {
    let rows = array(&payload["rows"]);
    if rows.len() != 300 {
        bail!(
            "expected institutional snapshot to contain exactly 300 rows, received {}",
            rows.len()
        );
    }
    let names: Vec<String> = rows
        .iter()
        .map(|r| text(&r["name"]).trim().to_owned())
        .collect();
    if names.iter().any(String::is_empty) {
        bail!("institutional snapshot contains an empty company name");
    }
    if names.iter().collect::<BTreeSet<_>>().len() != names.len() {
        bail!("institutional snapshot contains duplicate company names");
    }
    Ok(names)
}
fn keywords(state: &AppState, options: &Value) -> Result<Value> {
    let snapshot = state.config("web/src/config/institutional-track-snapshot.json")?;
    let names = names(&snapshot)?;
    let path = state.root.join(options["groupsFile"].as_str().filter(|p|!p.is_empty()).unwrap_or("/Users/terry/git/mitmproxy/config/capture-title-keyword-filters/shared-groups.json"));
    let (bytes, mut payload) = read(&path)?;
    if !payload["groups"].is_object() {
        bail!("invalid keyword groups payload: {}", path.display());
    }
    let existing: Vec<String> = array(&payload["groups"]["institutionalTop300"])
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        })
        .collect();
    let missing = names.iter().filter(|n| !existing.contains(n)).count();
    let extra = existing.iter().filter(|n| !names.contains(n)).count();
    if options["check"] == true {
        if existing != names {
            bail!("institutionalTop300 is out of sync: missing={missing}, extra={extra}");
        }
        Ok(json!({"groupsPath":path,"keywords":names.len(),"inSync":true}))
    } else {
        payload["groups"]["institutionalTop300"] = json!(names);
        replace(&path, &bytes, &payload)?;
        Ok(json!({"groupsPath":path,"keywords":names.len(),"added":missing,"removed":extra}))
    }
}
pub async fn run(state: &AppState, operation: &str, options: &Value) -> Result<Value> {
    match operation {
        "valuation" => valuation(state, options),
        "institutional-keywords" => keywords(state, options),
        _ => bail!("unknown configuration sync operation: {operation}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn valuation_metadata_is_deterministic_and_dates_only_use_primary_evidence() {
        let mut data = json!({"companies":[{"id":"x","themeTags":["z","原有"],"evidenceRefs":[{"kind":"secondary","publishedAt":"2099-01-01"},{"kind":"primary","publishedAt":"2026-01-02"},{"kind":"primary","publishedAt":"2026-01-01"}]}]});
        let derived = json!({"companies":[{"companyId":"x","factors":[{"factor":"b","weight":"primary","direction":"mixed","label":"因子"},{"factor":"a","weight":"secondary","direction":"positive","label":"因子"}],"valuationProfile":{"archetype":"bank"},"researchTier":{"priority":"L2","watchStatus":"priority","basis":["evidence"]}}]});
        let (changed, drift) = materialize(&mut data, &derived);
        assert!(changed);
        assert_eq!(drift.len(), 5);
        assert_eq!(data["companies"][0]["lastEvidenceDate"], "2026-01-02");
        assert_eq!(data["companies"][0]["factorExposures"][0]["factor"], "a");
        assert_eq!(
            data["companies"][0]["themeTags"],
            json!(["z", "原有", "因子"])
        );
        assert_eq!(materialize(&mut data, &derived), (false, BTreeSet::new()));
    }
    #[test]
    fn names_require_all_three_hundred_distinct_nonempty_rows() {
        let mut snapshot = json!({"rows":(0..300).map(|i|json!({"name":format!(" 公司{i} ")})).collect::<Vec<_>>()});
        assert_eq!(names(&snapshot).unwrap()[0], "公司0");
        snapshot["rows"][1]["name"] = json!(" 公司0 ");
        assert!(names(&snapshot).is_err());
        snapshot["rows"][1]["name"] = json!(" ");
        assert!(names(&snapshot).is_err());
        snapshot["rows"].as_array_mut().unwrap().pop();
        assert!(names(&snapshot).is_err());
    }
    #[test]
    fn atomic_replace_rejects_a_stale_config_and_preserves_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, b"{}").unwrap();
        replace(&path, b"{}", &json!({"done":true})).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(replace(&path, b"{}", &json!({})).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    fn state_fixture() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(dir.path().join("fixture.sqlite")).unwrap();
        let state = AppState::new(db, dir.path().into(), "127.0.0.1:8000".into()).unwrap();
        (dir, state)
    }
    fn fixture_json(state: &AppState, path: &str, value: &Value) {
        let path = state.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    }
    #[tokio::test]
    async fn valuation_check_is_readonly_and_write_converges() {
        let (_dir, state) = state_fixture();
        fixture_json(
            &state,
            "config/investment-universe.json",
            &json!({"companies":[{"id":"fixture","displayName":"fixture","primaryTrackId":"bank","preferredTicker":"600000.SH","themeTags":[],"evidenceRefs":[],"securities":[{"ticker":"600000.SH","identityVerified":true}]}]}),
        );
        fixture_json(
            &state,
            "config/research/research-eastmoney-em2016-industry-profiles.json",
            &json!({"profiles":[]}),
        );
        fixture_json(
            &state,
            "config/generated/eastmoney-company-em2016-profiles.json",
            &json!({"profiles":[]}),
        );
        let path = state.root.join("config/investment-universe.json");
        let before = fs::read(&path).unwrap();
        assert!(
            run(&state, "valuation", &json!({"check":true}))
                .await
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        let wrote = run(&state, "valuation", &json!({"write":true}))
            .await
            .unwrap();
        assert_eq!(wrote["companies"], 1);
        assert!(wrote["driftItems"].as_u64().unwrap() > 0);
        let after = fs::read(&path).unwrap();
        assert_eq!(
            run(&state, "valuation", &json!({})).await.unwrap()["driftItems"],
            0
        );
        assert_eq!(fs::read(&path).unwrap(), after);
    }
    #[tokio::test]
    async fn keyword_check_and_write_preserve_other_groups() {
        let (_dir, state) = state_fixture();
        fixture_json(
            &state,
            "web/src/config/institutional-track-snapshot.json",
            &json!({"rows":(0..300).map(|i|json!({"name":format!("公司{i}")})).collect::<Vec<_>>()}),
        );
        fixture_json(
            &state,
            "groups.json",
            &json!({"groups":{"institutionalTop300":["旧名"],"other":["keep"]},"version":42}),
        );
        let path = state.root.join("groups.json");
        let before = fs::read(&path).unwrap();
        assert!(
            run(
                &state,
                "institutional-keywords",
                &json!({"groupsFile":"groups.json","check":true})
            )
            .await
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        let wrote = run(
            &state,
            "institutional-keywords",
            &json!({"groupsFile":"groups.json"}),
        )
        .await
        .unwrap();
        assert_eq!(wrote["added"], 300);
        assert_eq!(wrote["removed"], 1);
        let payload = read(&path).unwrap().1;
        assert_eq!(payload["groups"]["other"], json!(["keep"]));
        assert_eq!(payload["version"], 42);
        assert_eq!(
            run(
                &state,
                "institutional-keywords",
                &json!({"groupsFile":"groups.json","check":true})
            )
            .await
            .unwrap()["inSync"],
            true
        );
    }
}
