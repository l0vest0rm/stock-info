//! Opt-in real provider check; never opens the user's database or submits taskd work.
use serde_json::{Value, json};
use stock_info_local::{AppState, db::Database, research::taskd};

#[tokio::test]
#[ignore = "requires explicit LLM_RUNTIME=local, ROUTING_API_KEY and live routing service"]
async fn real_configured_llm_stream_and_json() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(
        Database::open(dir.path().join("test.sqlite")).unwrap(),
        root.into(),
        "127.0.0.1:18099".into(),
    )
    .unwrap();
    let config = stock_info_local::llm::config(&state).unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let result = taskd::direct_text_events(&state, &json!({
        "expectedModel":config.model,
        "instructions":"Return only a JSON object with key ok and boolean value true. No markdown.",
        "input":[
            {"role":"user","content":[{"type":"input_text","text":"Prepare the JSON."}]},
            {"role":"assistant","content":[{"type":"input_text","text":"Ready."}]},
            {"role":"user","content":[{"type":"input_text","text":"Now output it."}]}
        ],"maxTokens":256
    }), Some(sender)).await.unwrap();
    let parsed: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(parsed, json!({"ok":true}));
    let mut streamed = String::new();
    while let Some(delta) = receiver.recv().await {
        streamed.push_str(&delta);
    }
    assert_eq!(streamed.trim(), result);
}

#[test]
fn configured_chat_and_responses_use_one_trusted_route() {
    for protocol in ["chat_completions", "responses"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "configured_mock_child", "--nocapture"])
            .env("STOCK_LLM_MOCK_PROTOCOL", protocol)
            .env("LLM_RUNTIME", "local")
            .env("STOCK_LLM_TEST_KEY", "fixture-only")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}

#[tokio::test]
async fn configured_mock_child() {
    let Ok(protocol) = std::env::var("STOCK_LLM_MOCK_PROTOCOL") else {
        return;
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("config/app")).unwrap();
    std::fs::write(
        dir.path().join("config/app/llm.json"),
        json!({
            "model":"configured-model", "baseUrl":format!("http://{address}/v1"),
            "apiKeyEnv":"STOCK_LLM_TEST_KEY", "protocol":protocol
        })
        .to_string(),
    )
    .unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let (end, length) = loop {
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|s| s.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break (end, length);
                }
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..end]);
        assert!(headers.contains("Bearer fixture-only"));
        let body: Value = serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
        assert_eq!(body["model"], "configured-model");
        assert_eq!(body["stream"], true);
        let payload = if protocol == "chat_completions" {
            assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
            assert!(body.get("input").is_none());
            assert_eq!(
                body["messages"][0],
                json!({"role":"system","content":"instructions"})
            );
            assert_eq!(
                body["messages"][2],
                json!({"role":"assistant","content":"history"})
            );
            assert_eq!(body["max_tokens"], 123);
            "data: {\"model\":\"configured-model\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"not output\",\"content\":\"中文\"},\"finish_reason\":null}]}\r\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n"
        } else {
            assert!(headers.starts_with("POST /v1/responses HTTP/1.1"));
            assert_eq!(body["input"][1]["content"][0]["type"], "output_text");
            assert_eq!(body["store"], false);
            assert!(body.get("max_tokens").is_none());
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"中文\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"configured-model\"}}\n\n"
        };
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",payload.len()).as_bytes()).await.unwrap();
        for byte in payload.as_bytes() {
            socket.write_all(&[*byte]).await.unwrap();
        }
    });
    let state = AppState::new(
        Database::open(dir.path().join("test.sqlite")).unwrap(),
        dir.path().into(),
        "127.0.0.1:18099".into(),
    )
    .unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let result = taskd::direct_text_events(
        &state,
        &json!({
            "model":"untrusted-model", "baseUrl":"http://invalid", "apiKeyEnv":"UNTRUSTED",
            "expectedModel":"configured-model", "instructions":"instructions", "maxTokens":123,
            "input":[{"role":"user","content":[{"type":"input_text","text":"first"}]},
                     {"role":"assistant","content":[{"type":"input_text","text":"history"}]}]
        }),
        Some(sender),
    )
    .await
    .unwrap();
    assert_eq!(result, "中文");
    assert_eq!(receiver.recv().await.unwrap(), "中文");
    server.await.unwrap();
}
