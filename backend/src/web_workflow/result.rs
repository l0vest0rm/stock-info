use super::*;
use cea_sdk::WorkflowReport;
use std::{collections::BTreeSet, path::Path};

/// SDK HTML conversion escapes the dot in numbered headings. This is valid
/// Markdown, but business contracts use canonical `# N. Title` headings. Only
/// normalize that equivalent heading spelling; never manufacture sections.
pub fn canonical_markdown(raw: &str) -> String {
    regex::Regex::new(r"(?m)^(# [0-9]+)\\\. ")
        .expect("static heading pattern")
        .replace_all(raw, "$1. ")
        .into_owned()
}

pub fn extract_result(result: &Value) -> Result<Value> {
    ensure!(
        matches!(text(&result["format"]), FORMAT | "taskd.webqa.result.v2"),
        "unsupported browser research result format"
    );
    let content = &result["content"];
    ensure!(
        content["markdown"].is_string() && content["assets"].is_array(),
        "research result missing rich content"
    );
    ensure!(
        result["citations"].is_array() && result["sources"].is_array(),
        "research result missing citations/sources"
    );
    ensure!(
        result["raw_snapshot"].is_object()
            && result["terminal_evidence"].is_object()
            && result["execution"].is_object(),
        "research result missing snapshot/completion/execution evidence"
    );
    Ok(
        json!({"format":result["format"],"content":content,"citations":result["citations"],"sources":result["sources"],"rawSnapshot":result["raw_snapshot"],"terminalEvidence":result["terminal_evidence"],"execution":result["execution"]}),
    )
}

pub(crate) fn from_report(run: &Value, report: &WorkflowReport, dir: &Path) -> Result<Value> {
    ensure!(
        report.outputs.get("selected_model_text")
            == run["variables"]["model_label"]
                .as_str()
                .map(|s| s.to_string())
                .as_ref(),
        "workflow did not prove configured model selection"
    );
    let reasoning = report
        .outputs
        .get("selected_reasoning_text")
        .context("reasoning proof missing")?;
    ensure!(
        reasoning.contains(text(&run["variables"]["reasoning_label"])),
        "workflow did not prove reasoning selection"
    );
    let raw_markdown = std::fs::read_to_string(&report.markdown_path)?;
    let markdown = canonical_markdown(&raw_markdown);
    ensure!(
        !markdown.trim().is_empty(),
        "workflow returned empty markdown"
    );
    let html_path = dir.join("chatgpt-answer.html");
    let html = std::fs::read_to_string(&html_path)?;
    let rich = cea_sdk::rich_content(&html, &report.page_url)?;
    let proof: Value = serde_json::from_str(
        report
            .outputs
            .get("answer_text_sources")
            .context("source extraction proof missing")?,
    )?;
    ensure!(
        proof["errors"].as_array().is_some_and(Vec::is_empty),
        "source extraction incomplete; refusing lossy report"
    );
    let mut seen = BTreeSet::new();
    let mut sources = Vec::new();
    for item in proof["links"].as_array().into_iter().flatten().chain(
        rich["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["kind"] == "link"),
    ) {
        let url = text(&item["url"]);
        if !url.starts_with("https://") && !url.starts_with("http://") {
            continue;
        }
        if seen.insert(url.to_string()) {
            sources.push(
                json!({"url":url,"title":text(&item["label"]),"provenance":"browser_extraction"}),
            );
        }
    }
    let evidence = json!({"schemaVersion":"webqa.completion-evidence.v1","outcome":"succeeded","engine":"cea","runId":run["runId"],"workflowHash":run["workflowHash"],"serverInstanceId":report.server_instance_id,"pageId":report.page_id,"providerUrl":report.page_url,"completedAt":now(),"completion":"sdk_workflow_receipt","selectedModel":report.outputs["selected_model_text"],"reasoning":run["variables"]["reasoning_label"]});
    Ok(
        json!({"format":FORMAT,"content":{"format":"web-research.rich-content.v1","markdown":markdown,"plainText":rich["plainText"],"assets":rich["assets"]},"citations":sources,"sources":sources,
        "raw_snapshot":{"htmlSha256":hash(html.as_bytes()),"markdownSha256":hash(raw_markdown.as_bytes()),"canonicalMarkdownSha256":hash(markdown.as_bytes()),"sourceProof":proof},"terminal_evidence":evidence,
        "execution":{"engine":"cea","runId":run["runId"],"workflowHash":run["workflowHash"],"inputFingerprint":run["inputFingerprint"],"profile":run["profile"],"elapsedMs":report.elapsed.as_millis()}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbered_heading_canonicalization_is_semantic_not_validation_relaxation() {
        let raw = (1..=8)
            .map(|i| format!("# {i}\\. section\n{}\n", "body ".repeat(40)))
            .collect::<String>();
        let canonical = canonical_markdown(&raw);
        crate::research::financial_input::validate_markdown(&canonical).unwrap();
        assert!(
            crate::research::financial_input::validate_markdown(&canonical_markdown(
                "# 1\\. short"
            ))
            .is_err()
        );
        assert_eq!(
            canonical_markdown("body 1\\. x\n\\# 2\\. not heading\n## 3\\. subordinate"),
            "body 1\\. x\n\\# 2\\. not heading\n## 3\\. subordinate"
        );
    }
    #[test]
    fn incomplete_results_and_wrong_formats_are_rejected() {
        assert!(extract_result(&json!({"markdown":"not authoritative"})).is_err());
        let v = json!({"format":FORMAT,"content":{"markdown":"complete","assets":[]},"citations":[],"sources":[],"raw_snapshot":{},"terminal_evidence":{},"execution":{}});
        assert_eq!(
            extract_result(&v).unwrap()["content"]["markdown"],
            "complete"
        );
        let mut bad = v.clone();
        bad["sources"] = Value::Null;
        assert!(extract_result(&bad).is_err());
    }
    #[test]
    fn result_requires_model_effort_and_source_evidence() {
        let d = tempfile::tempdir().unwrap();
        let report = WorkflowReport {
            workflow_name: "fixture".into(),
            markdown_path: d.path().join("answer.md"),
            outputs: BTreeMap::new(),
            page_id: "p".into(),
            page_url: "https://example.test/".into(),
            server_instance_id: "s".into(),
            elapsed: std::time::Duration::ZERO,
        };
        assert!(from_report(&json!({"variables":{"model_label":"A"}}), &report, d.path()).is_err());
    }
    #[test]
    fn structured_json_uses_literal_dom_text_not_linkified_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let raw = r#"[{"url":"https://example.test/report_1"}]"#;
        std::fs::write(dir.path().join("chatgpt-answer.html"), r#"<div><p>[{"url":"<a href="https://example.test/report_1">https://example.test/report_1</a>"}]</p></div>"#).unwrap();
        let path = dir.path().join("answer.md");
        std::fs::write(
            &path,
            r#"\[{"url":"[https://example.test/report_1](https://example.test/report_1)"}\]"#,
        )
        .unwrap();
        let report = WorkflowReport {
            workflow_name: "fixture".into(),
            markdown_path: path,
            outputs: BTreeMap::from([
                ("selected_model_text".into(), "A".into()),
                ("selected_reasoning_text".into(), "High".into()),
                (
                    "answer_text_sources".into(),
                    json!({"links":[],"errors":[]}).to_string(),
                ),
            ]),
            page_id: "p".into(),
            page_url: "https://example.test/".into(),
            server_instance_id: "s".into(),
            elapsed: std::time::Duration::ZERO,
        };
        let result = from_report(
            &json!({"variables":{"model_label":"A","reasoning_label":"High"}}),
            &report,
            dir.path(),
        )
        .unwrap();
        assert_eq!(result["content"]["plainText"], raw);
        assert!(
            serde_json::from_str::<Value>(text(&result["content"]["plainText"]))
                .unwrap()
                .is_array()
        );
    }
}
