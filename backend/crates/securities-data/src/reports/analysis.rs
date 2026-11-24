//! Report extraction orchestration; the host supplies prompts and its LLM client.
use super::domain;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::future::Future;

pub struct AnalysisOptions<'a> {
    pub runtime: &'a str,
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub user_template: &'a str,
}

/// Normalize/truncate report text, request structured extraction, and validate
/// the response. No credential lookup, provider scheduling or publication.
/// The callback owns routing/streaming and receives the existing LLM JSON shape.
pub async fn analyze<F, Fut>(
    title: &str,
    content: &str,
    options: AnalysisOptions<'_>,
    complete: F,
) -> Result<Value>
where
    F: FnOnce(Value) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    if options.runtime != "local" {
        bail!("company report LLM extraction is only available in local runtime");
    }
    let content = domain::format_for_llm(content)
        .trim()
        .chars()
        .take(12000)
        .collect::<String>();
    if content.is_empty() {
        return Ok(
            json!({"forecasts":[],"targetPrice":null,"rawResponseText":"{\"forecasts\":[],\"targetPrice\":null}"}),
        );
    }
    let user = options
        .user_template
        .trim()
        .replacen("{{TITLE}}", title, 1)
        .replacen("{{CONTENT}}", &content, 1);
    let request = json!({"model":options.model,"instructions":options.system_prompt.trim(),"input":[{"role":"user","content":[{"type":"input_text","text":user}]}],"maxTokens":4096});
    let response = complete(request).await?;
    let mut analysis = domain::parse_analysis(&response)?;
    analysis["rawResponseText"] = json!(response);
    Ok(analysis)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(runtime: &str) -> AnalysisOptions<'_> {
        AnalysisOptions {
            runtime,
            model: "host-model",
            system_prompt: " system ",
            user_template: "{{TITLE}}\n{{CONTENT}}",
        }
    }

    #[tokio::test]
    async fn nonlocal_and_empty_input_never_call_provider() {
        assert!(
            analyze("title", "content", options(""), |_| async {
                panic!("unexpected provider call")
            })
            .await
            .is_err()
        );
        let empty = analyze("title", "  ", options("local"), |_| async {
            panic!("unexpected provider call")
        })
        .await
        .unwrap();
        assert_eq!(empty["forecasts"], json!([]));
    }

    #[tokio::test]
    async fn injected_llm_preserves_request_and_raw_response() {
        let response = r#"{"forecasts":[],"targetPrice":null}"#;
        let value = analyze("report", "body", options("local"), |request| async move {
            assert_eq!(request["model"], "host-model");
            assert_eq!(request["instructions"], "system");
            assert_eq!(request["input"][0]["content"][0]["text"], "report\nbody");
            Ok(response.into())
        })
        .await
        .unwrap();
        assert_eq!(value["rawResponseText"], response);
        assert!(
            analyze("report", "body", options("local"), |_| async {
                anyhow::bail!("provider unavailable")
            })
            .await
            .is_err()
        );
    }
}
