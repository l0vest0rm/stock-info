use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::future::IntoFuture;
use std::{
    env,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};
use stock_info_local::{AppState, content_router, db::Database, router, scheduler};
use tokio::sync::watch;

const HELP: &str = "stock-info-local [COMMAND] [OPTIONS]\nRun from the repository root. No command starts both loopback HTTP listeners.\nCommands: --migrate-only, --cron-once, --refresh-xueqiu-cookie,\n  --validate-xueqiu-cookie, --process-knowledge, --process-knowledge-existing,\n  --process-feed, --reconcile-feed, --backfill-feed-relevance,\n  --backfill-information-records, --prepare-featured-report,\n  --publish-featured-report, --review-featured-report, --maintenance OP, --research OP, --sync OP\nWorkflow flags use kebab-case; destructive maintenance requires --apply.\nHOST must be a loopback IP; PORT defaults to 8000; KNOWLEDGE_CONTENT_LOCAL_PORT to 8788.\nLOCAL_DB_PATH or LOCAL_DATA_DIR select SQLite. Existing migrations are preserved.\nModel work requires explicit LLM_RUNTIME=local. Credentials are read from ignored .dev.vars.";

fn port(name: &str, fallback: &str) -> Result<u16> {
    let value = env::var(name).unwrap_or_else(|_| fallback.into());
    let port = value
        .parse::<u16>()
        .with_context(|| format!("invalid {name}"))?;
    if port == 0 {
        bail!("{name} must be between 1 and 65535");
    }
    Ok(port)
}

#[tokio::main]
async fn main() -> Result<()> {
    let root = env::current_dir()?;
    // Existing shell settings win. The binary never enables model execution
    // merely because credentials exist in this ignored local file.
    let _ = dotenvy::from_path(root.join(".dev.vars"));
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|s| s == "--help" || s == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    let command = args.first().map(String::as_str).unwrap_or("");
    let commands = [
        "",
        "--migrate-only",
        "--cron-once",
        "--refresh-xueqiu-cookie",
        "--validate-xueqiu-cookie",
        "--process-knowledge",
        "--process-knowledge-existing",
        "--process-feed",
        "--reconcile-feed",
        "--backfill-feed-relevance",
        "--backfill-information-records",
        "--prepare-featured-report",
        "--publish-featured-report",
        "--review-featured-report",
        "--maintenance",
        "--research",
        "--sync",
    ];
    if !commands.contains(&command) {
        bail!("unknown command; use --help");
    }
    let options = parse_options(command, args.get(1..).unwrap_or_default())?;
    let host: IpAddr = env::var("HOST")
        .unwrap_or_else(|_| "127.0.0.1".into())
        .parse()
        .context("HOST must be a loopback IP address")?;
    if !host.is_loopback() {
        bail!("only loopback HOST addresses are supported");
    }
    let address = SocketAddr::new(host, port("PORT", "8000")?);
    let content_port = env::var("LOCAL_CONTENT_PORT").unwrap_or_else(|_| "8788".into());
    let content_address =
        SocketAddr::new(host, port("KNOWLEDGE_CONTENT_LOCAL_PORT", &content_port)?);
    // Acquire BOTH listeners before opening/migrating SQLite. Never replace
    // an existing service, kill its jobs, or mutate data on a bind failure.
    let listeners = if command.is_empty() {
        let api = tokio::net::TcpListener::bind(address)
            .await
            .with_context(|| {
                format!("cannot bind local API {address}; existing services were not stopped")
            })?;
        let content = tokio::net::TcpListener::bind(content_address).await
            .with_context(|| format!("cannot bind local content {content_address}; existing services were not stopped"))?;
        Some((api, content))
    } else {
        None
    };
    let data = PathBuf::from(env::var("LOCAL_DATA_DIR").unwrap_or_else(|_| "data/local".into()));
    let database = Database::open(
        env::var_os("LOCAL_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("stock-info.sqlite")),
    )?;
    let migrations = root.join("migrations");
    let db = database.clone();
    let applied = tokio::task::spawn_blocking(move || db.migrate(&migrations)).await??;
    eprintln!("SQLite ready ({applied} migrations applied)");
    if command == "--migrate-only" {
        return Ok(());
    }
    let mut state = AppState::new(database, root.clone(), address.to_string())?;
    if state.version.is_empty() {
        state.version = "local-rust".into();
    }
    let Some((api_listener, content_listener)) = listeners else {
        let result = run_command(&state, command, &options).await;
        state.tasks.close();
        state.tasks.wait().await;
        let result = result?;
        if command == "--research" && options["operation"] == "buy-point" && options["json"] != true
        {
            print!(
                "{}",
                stock_info_local::research_cli::buy_point::render_text(&result)
            );
        } else {
            println!("{}", serde_json::to_string(&result)?);
        }
        if (command == "--backfill-information-records" || command == "--research")
            && result["errors"]
                .as_array()
                .is_some_and(|errors| !errors.is_empty())
        {
            bail!("local workflow completed with errors; see the JSON report");
        }
        return Ok(());
    };
    let assets = env::var_os("LOCAL_ASSETS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("web/dist"));
    let jobs = scheduler::start(state.clone())?;
    let mut content_state = state.clone();
    content_state.authority = content_address.to_string();
    let (stop, stopped) = watch::channel(false);
    let mut api_task = tokio::spawn(
        axum::serve(api_listener, router(state.clone(), &assets))
            .with_graceful_shutdown(wait_stop(stopped.clone()))
            .into_future(),
    );
    let mut content_task = tokio::spawn(
        axum::serve(
            content_listener,
            content_router(content_state, address.to_string()),
        )
        .with_graceful_shutdown(wait_stop(stopped))
        .into_future(),
    );
    eprintln!("Rust local API: http://{address}; content: http://{content_address}");
    // Watch unexpected server exit as well as signals. Do not abandon accepted
    // calculations or scheduler jobs merely because a browser disconnects.
    let (api_done, content_done, early_result) = tokio::select! {
        result = &mut api_task => (true, false, Some(result)),
        result = &mut content_task => (false, true, Some(result)),
        _ = shutdown() => (false, false, None),
    };
    jobs.request_stop();
    let _ = stop.send(true);
    let api_result = if api_done { None } else { Some(api_task.await) };
    let content_result = if content_done {
        None
    } else {
        Some(content_task.await)
    };
    jobs.stop().await;
    state.tasks.close();
    state.tasks.wait().await;
    for result in [early_result, api_result, content_result]
        .into_iter()
        .flatten()
    {
        result??;
    }
    Ok(())
}

async fn run_command(state: &AppState, command: &str, options: &Value) -> Result<Value> {
    match command {
        "--cron-once" => scheduler::run_once(state).await,
        "--refresh-xueqiu-cookie" => stock_info_local::cookie_refresh::refresh(state).await,
        "--validate-xueqiu-cookie" => stock_info_local::cookie_refresh::validate(state).await,
        "--process-knowledge" => {
            stock_info_local::knowledge::ingest::process_once_with_config(
                state,
                knowledge_config(state, options)?,
            )
            .await
        }
        "--process-knowledge-existing" => {
            stock_info_local::knowledge::ingest::process_inboxes(
                state,
                knowledge_config(state, options)?,
            )
            .await
        }
        "--process-feed" => {
            stock_info_local::feed_processing::process(state, options.clone()).await
        }
        "--reconcile-feed" => {
            stock_info_local::feed_processing::reconcile(state, options.clone()).await
        }
        "--backfill-feed-relevance" => {
            stock_info_local::feed_processing::backfill_relevance(state, options.clone()).await
        }
        "--backfill-information-records" => {
            stock_info_local::feed_processing::backfill_records(state, options.clone()).await
        }
        "--prepare-featured-report" => {
            stock_info_local::featured_workflow::prepare(state, options).await
        }
        "--publish-featured-report" => {
            stock_info_local::featured_workflow::publish(state, options).await
        }
        "--review-featured-report" => {
            let directory = options["directory"]
                .as_str()
                .context("review requires a report directory")?;
            let review_port = options["port"].as_u64().unwrap_or(8791);
            if review_port == 0 || review_port > u16::MAX as u64 {
                bail!("invalid review port");
            }
            stock_info_local::featured_workflow::review(
                state.clone(),
                &state.root.join(directory),
                review_port as u16,
            )
            .await?;
            Ok(json!({"status":"stopped"}))
        }
        "--research" => {
            stock_info_local::research_cli::run(
                state,
                options["operation"]
                    .as_str()
                    .context("research requires operation")?,
                options,
            )
            .await
        }
        "--sync" => {
            stock_info_local::sync_cli::run(
                state,
                options["operation"]
                    .as_str()
                    .context("sync requires operation")?,
                options,
            )
            .await
        }
        "--maintenance" => {
            stock_info_local::maintenance::run(
                state,
                options["operation"]
                    .as_str()
                    .context("maintenance requires operation")?,
                options,
            )
            .await
        }
        _ => bail!("unknown command"),
    }
}

fn knowledge_config(state: &AppState, options: &Value) -> Result<Value> {
    let path = options["config"]
        .as_str()
        .unwrap_or("config/knowledge/knowledge-processing.json");
    let mut config = state.config(path)?;
    if !config.is_object() {
        bail!("knowledge configuration must be an object");
    }
    if let Some(inbox) = options["inbox"].as_str() {
        config["inboxDir"] = json!(inbox);
        config["inputDirs"] = json!([inbox]);
    }
    if let Some(extra) = options["extraInput"].as_array() {
        let mut dirs = config["inputDirs"].as_array().cloned().unwrap_or_default();
        dirs.extend(extra.iter().cloned());
        config["inputDirs"] = json!(dirs);
    }
    for (option, key) in [
        ("archiveProcessed", "archiveProcessed"),
        ("fullRescan", "fullRescan"),
        ("noAgeLimit", "disableAgeLimit"),
    ] {
        if let Some(value) = options.get(option) {
            config[key] = value.clone();
        }
    }
    Ok(config)
}

fn parse_options(command: &str, args: &[String]) -> Result<Value> {
    let mut options = serde_json::Map::new();
    let mut index = 0;
    let allowed: &[&str] = match command {
        "--process-knowledge" | "--process-knowledge-existing" => &[
            "config",
            "inbox",
            "extraInput",
            "local",
            "archiveProcessed",
            "fullRescan",
            "noAgeLimit",
        ],
        "--process-feed" => &[
            "mode",
            "file",
            "docId",
            "retryFailed",
            "maxDocuments",
            "maxTags",
            "lookbackDays",
            "maxAgeHours",
        ],
        "--reconcile-feed" | "--backfill-feed-relevance" => &["apply", "dryRun"],
        "--backfill-information-records" => &[
            "apply",
            "dryRun",
            "database",
            "docId",
            "report",
            "archiveDir",
            "contentDir",
            "quarantine",
            "quarantineInvalid",
        ],
        "--prepare-featured-report" => &[
            "input",
            "out",
            "title",
            "institution",
            "date",
            "extractOnly",
            "refilter",
        ],
        "--publish-featured-report" => &["directory", "baseUrl"],
        "--review-featured-report" => &["directory", "port"],
        "--research" => &[
            "operation",
            "config",
            "asOf",
            "reportDate",
            "days",
            "limit",
            "baseUrl",
            "output",
            "includeConsensus",
            "fundCode",
            "concurrency",
            "dryRun",
            "force",
            "code",
            "from",
            "json",
        ],
        "--sync" => &[
            "operation",
            "codes",
            "input",
            "concurrency",
            "refreshExisting",
            "dryRun",
            "manifest",
            "apply",
            "indexes",
            "batchSize",
            "db",
            "marketCapCount",
            "turnoverCount",
            "delete",
            "dir",
            "check",
            "write",
            "json",
            "groupsFile",
        ],
        "--maintenance" => &[
            "operation",
            "file",
            "config",
            "apply",
            "dryRun",
            "maxAgeDays",
            "contentDir",
            "source",
            "output",
            "namespace",
            "syncFile",
            "resultFile",
            "reviewDir",
            "prefix",
            "minAgeDays",
            "disableRetention",
            "skipRunRecord",
            "local",
            "writeDevVars",
        ],
        _ => &[],
    };
    while index < args.len() {
        let argument = &args[index];
        if !argument.starts_with("--") {
            let key = match command {
                "--prepare-featured-report" => "input",
                "--publish-featured-report" | "--review-featured-report" => "directory",
                "--maintenance" | "--sync" => "operation",
                "--research" => {
                    if !options.contains_key("operation") {
                        "operation"
                    } else {
                        match options["operation"].as_str() {
                            Some("buy-point") => "code",
                            Some("institutional-tracks") => "baseUrl",
                            _ => bail!("unexpected positional argument"),
                        }
                    }
                }
                _ => bail!("unexpected positional argument"),
            };
            if options.contains_key(key) {
                bail!("duplicate {key}");
            }
            options.insert(key.into(), Value::String(argument.clone()));
            index += 1;
            continue;
        }
        let (flag, inline) = argument[2..]
            .split_once('=')
            .map_or((&argument[2..], None), |(k, v)| (k, Some(v)));
        let mut words = flag.split('-');
        let mut key = words.next().unwrap_or_default().to_owned();
        for word in words {
            let mut chars = word.chars();
            if let Some(first) = chars.next() {
                key.extend(first.to_uppercase());
                key.extend(chars);
            }
        }
        if !allowed.contains(&key.as_str()) {
            bail!("unsupported option --{flag}");
        }
        let boolean = [
            "apply",
            "dryRun",
            "retryFailed",
            "force",
            "extractOnly",
            "refilter",
            "quarantine",
            "quarantineInvalid",
            "local",
            "writeDevVars",
            "archiveProcessed",
            "fullRescan",
            "noAgeLimit",
            "disableRetention",
            "skipRunRecord",
            "includeConsensus",
            "json",
            "refreshExisting",
            "delete",
            "check",
            "write",
        ]
        .contains(&key.as_str());
        let value = if boolean {
            match inline {
                None | Some("true") => Value::Bool(true),
                Some("false") => Value::Bool(false),
                _ => bail!("--{flag} requires true or false"),
            }
        } else {
            let raw = match inline {
                Some(raw) => raw,
                None => {
                    index += 1;
                    args.get(index)
                        .filter(|s| !s.starts_with("--"))
                        .context("option requires a value")?
                }
            };
            if [
                "maxDocuments",
                "maxTags",
                "lookbackDays",
                "maxAgeHours",
                "maxAgeDays",
                "minAgeDays",
                "limit",
                "port",
                "days",
                "concurrency",
                "batchSize",
                "marketCapCount",
                "turnoverCount",
            ]
            .contains(&key.as_str())
            {
                Value::Number(
                    raw.parse::<u64>()
                        .context("numeric option requires a nonnegative integer")?
                        .into(),
                )
            } else {
                Value::String(raw.to_string())
            }
        };
        if key == "extraInput" {
            options
                .entry(key)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .context("invalid extra input")?
                .push(value);
            index += 1;
            continue;
        }
        if options.insert(key.clone(), value).is_some() {
            bail!("duplicate --{flag}");
        }
        index += 1;
    }
    if options.get("apply") == Some(&Value::Bool(true))
        && options.get("dryRun") == Some(&Value::Bool(true))
    {
        bail!("--apply and --dry-run conflict");
    }
    if let Some(value) = options.remove("quarantineInvalid") {
        options.insert("quarantine".into(), value);
    }
    Ok(Value::Object(options))
}

async fn wait_stop(mut stopped: watch::Receiver<bool>) {
    if !*stopped.borrow() {
        let _ = stopped.wait_for(|stopped| *stopped).await;
    }
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn workflow_options_preserve_flags_paths_and_numbers() {
        let value = parse_options(
            "--process-feed",
            &args(&[
                "--doc-id",
                "one",
                "--retry-failed",
                "--max-documents=12",
                "--mode",
                "ingest",
            ]),
        )
        .unwrap();
        assert_eq!(
            value,
            json!({"docId":"one","retryFailed":true,"maxDocuments":12,"mode":"ingest"})
        );
        let value = parse_options(
            "--prepare-featured-report",
            &args(&["a report.pdf", "--out", "my directory", "--extract-only"]),
        )
        .unwrap();
        assert_eq!(value["input"], "a report.pdf");
        assert_eq!(value["out"], "my directory");
        assert_eq!(value["extractOnly"], true);
        let value =
            parse_options("--maintenance", &args(&["cleanup-content", "--dry-run"])).unwrap();
        assert_eq!(value["operation"], "cleanup-content");
        assert_eq!(value["dryRun"], true);
        let value = parse_options(
            "--process-knowledge",
            &args(&[
                "--inbox",
                "inbox",
                "--extra-input",
                "first",
                "--extra-input=second",
                "--full-rescan",
                "--no-age-limit",
            ]),
        )
        .unwrap();
        assert_eq!(value["extraInput"], json!(["first", "second"]));
        assert_eq!(value["fullRescan"], true);
        assert_eq!(value["noAgeLimit"], true);
    }
    #[test]
    fn research_and_sync_keep_original_cli_options() {
        let value = parse_options(
            "--research",
            &args(&[
                "buy-point",
                "600036.SH",
                "--as-of",
                "2026-10-29",
                "--include-consensus",
                "--json",
            ]),
        )
        .unwrap();
        assert_eq!(value["operation"], "buy-point");
        assert_eq!(value["code"], "600036.SH");
        assert_eq!(value["includeConsensus"], true);
        assert_eq!(value["json"], true);
        let value = parse_options(
            "--sync",
            &args(&[
                "profiles",
                "--refresh-existing",
                "--concurrency",
                "4",
                "--codes",
                "600036.SH,000001.SZ",
            ]),
        )
        .unwrap();
        assert_eq!(value["operation"], "profiles");
        assert_eq!(value["refreshExisting"], true);
        assert_eq!(value["concurrency"], 4);
        let value =
            parse_options("--sync", &args(&["repair-income", "--delete", "--check"])).unwrap();
        assert_eq!(value["delete"], true);
        assert_eq!(value["check"], true);
        assert!(parse_options("--sync", &args(&["sp500", "--remote"])).is_err());
    }
    #[test]
    fn knowledge_inbox_replaces_roots_before_extra_inputs() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("config/knowledge")).unwrap();
        std::fs::write(
            root.path()
                .join("config/knowledge/knowledge-processing.json"),
            r#"{"inputDirs":["old-root"],"fullRescan":false}"#,
        )
        .unwrap();
        let db = Database::open(root.path().join("db.sqlite")).unwrap();
        let state = AppState::new(db, root.path().to_path_buf(), "127.0.0.1:8000".into()).unwrap();
        let options = parse_options(
            "--process-knowledge",
            &args(&[
                "--inbox",
                "new-root",
                "--extra-input",
                "extra",
                "--full-rescan",
                "--no-age-limit",
            ]),
        )
        .unwrap();
        let config = knowledge_config(&state, &options).unwrap();
        assert_eq!(config["inputDirs"], json!(["new-root", "extra"]));
        assert_eq!(config["fullRescan"], true);
        assert_eq!(config["disableAgeLimit"], true);
        assert_eq!(
            knowledge_config(&state, &json!({"extraInput":["extra"]})).unwrap()["inputDirs"],
            json!(["old-root", "extra"])
        );
    }
    #[test]
    fn malformed_or_remote_options_fail_before_database_open() {
        for (command, flags) in [
            ("--cron-once", vec!["--apply"]),
            ("--process-feed", vec!["--mode"]),
            ("--process-feed", vec!["--retry-failed=maybe"]),
            ("--process-feed", vec!["--max-documents=-1"]),
            ("--prepare-featured-report", vec!["a.pdf", "b.pdf"]),
            ("--publish-featured-report", vec!["--remote"]),
            (
                "--maintenance",
                vec!["cleanup-docs", "--apply", "--dry-run"],
            ),
        ] {
            assert!(
                parse_options(command, &args(&flags)).is_err(),
                "{command} {flags:?}"
            );
        }
    }
}
