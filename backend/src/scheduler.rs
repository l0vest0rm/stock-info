//! Local scheduling owns no external worker/Node child. Database fencing still
//! arbitrates dashboard work across HTTP and every process sharing SQLite.
use crate::AppState;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Datelike, Timelike, Utc};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Semaphore, watch},
    task::{JoinHandle, JoinSet},
};

const FINANCE: &str = "*/15 * * * *";
const DASHBOARD: &str = "* * * * *";
const MACRO: &str = "17 * * * *";

#[derive(Clone, Debug)]
pub struct Cron {
    fields: [Vec<u32>; 5],
}
impl Cron {
    pub fn parse(expression: &str) -> Result<Self> {
        let parts = expression.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 5 {
            bail!("cron requires five fields");
        }
        let mut fields: [Vec<u32>; 5] = Default::default();
        for (index, (low, high)) in [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
            .into_iter()
            .enumerate()
        {
            for entry in parts[index].split(',') {
                let (range, step) = match entry.split_once('/') {
                    Some((range, step)) => (range, step.parse::<u32>()?),
                    None => (entry, 1),
                };
                if step == 0 {
                    bail!("cron step must be positive");
                }
                let (start, end) = if range == "*" {
                    (low, high)
                } else if let Some((start, end)) = range.split_once('-') {
                    (start.parse()?, end.parse()?)
                } else {
                    let n = range.parse()?;
                    (n, n)
                };
                if start < low || end > high || end < start {
                    bail!("cron field out of range");
                }
                for value in (start..=end).step_by(step as usize) {
                    fields[index].push(if index == 4 && value == 7 { 0 } else { value });
                }
            }
            fields[index].sort_unstable();
            fields[index].dedup();
        }
        Ok(Self { fields })
    }
    pub fn matches<T: chrono::TimeZone>(&self, time: &DateTime<T>) -> bool {
        let values = [
            time.minute(),
            time.hour(),
            time.day(),
            time.month(),
            time.weekday().num_days_from_sunday(),
        ];
        // Supported production-replacement schedules use unrestricted day
        // fields. Standard numeric/range/list/step local schedules are accepted.
        values
            .iter()
            .enumerate()
            .all(|(i, v)| self.fields[i].contains(v))
    }
}

pub fn event(role: &str, name: &str, details: Value) {
    println!(
        "{}",
        json!({"time":Utc::now().to_rfc3339(),"role":role,"event":name,"pid":std::process::id(),"details":details})
    );
}

pub async fn dispatch(state: &AppState, cron: &str, scheduled_ms: i64) -> Result<Value> {
    match cron {
        DASHBOARD => crate::dashboard::refresh_batch(state, 12).await,
        FINANCE => crate::finance::sync_provisional(state, scheduled_ms).await,
        MACRO => crate::macro_data::sync(state, scheduled_ms).await,
        _ => bail!("unsupported scheduled cron: {cron}"),
    }
}

pub async fn run_once(state: &AppState) -> Result<Value> {
    let now = Utc::now().timestamp_millis();
    let (finance, dashboard, macro_data) = tokio::try_join!(
        dispatch(state, FINANCE, now),
        dispatch(state, DASHBOARD, now),
        dispatch(state, MACRO, now)
    )?;
    let reconcile = reconcile(state).await;
    Ok(json!({"finance":finance,"dashboard":dashboard,"macro":macro_data,"reconcile":reconcile}))
}

async fn reconcile(state: &AppState) -> Value {
    // A failed projection does not prevent unrelated durable projections from
    // being inspected, and observers never submit or replay model work.
    let (research, macro_data, company) = tokio::join!(
        crate::research::reconcile(state),
        crate::macro_data::reconcile(state),
        crate::company::reconcile_discoveries(state)
    );
    let result = |name: &str, value: Result<Value>| match value {
        Ok(value) => value,
        Err(error) => {
            event(
                "local-scheduler",
                "reconcile_failed",
                json!({"scope":name,"error":error.to_string()}),
            );
            json!({"failed":true})
        }
    };
    json!({"research":result("research",research),"macro":result("macro",macro_data),"company":result("company",company)})
}

pub struct Scheduler {
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Scheduler {
    pub fn request_stop(&self) {
        let _ = self.stop.send(true);
    }
    pub async fn stop(self) {
        self.request_stop();
        let _ = self.task.await;
    }
}

pub fn start(state: AppState) -> Result<Scheduler> {
    let config_path = state.setting("LOCAL_CRON_CONFIG");
    let config = state.config(if config_path.is_empty() {
        "config/app/local-runtime.json"
    } else {
        &config_path
    })?;
    let expressions = config["triggers"]["crons"]
        .as_array()
        .context("local triggers.crons must be an array")?;
    let mut schedules = Vec::new();
    for entry in expressions {
        let expression = entry.as_str().context("cron must be a string")?;
        if ![FINANCE, DASHBOARD, MACRO].contains(&expression) {
            bail!("unsupported scheduled cron: {expression}");
        }
        schedules.push((expression.to_string(), Cron::parse(expression)?));
    }
    let ingest_config_path = state.setting("LOCAL_KNOWLEDGE_INGEST_CONFIG");
    let ingest_config = state.config(if ingest_config_path.is_empty() {
        "config/knowledge/knowledge-processing.json"
    } else {
        &ingest_config_path
    })?;
    let automation = &ingest_config["automation"];
    let ingest_enabled =
        state.setting("KNOWLEDGE_INGEST_SCHEDULER") != "0" && automation["enabled"] != false;
    let ingest_cron = Cron::parse(automation["cron"].as_str().unwrap_or("*/15 * * * *"))?;
    let run_ingest_on_start = automation["runOnStart"] == true;
    let (stop, mut stopping) = watch::channel(false);
    let disabled = state.setting("LOCAL_SCHEDULER") == "0";
    let task = tokio::spawn(async move {
        if disabled {
            event(
                "local-scheduler",
                "disabled",
                json!({"reason":"LOCAL_SCHEDULER=0"}),
            );
            return;
        }
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut jobs = JoinSet::new();
        let mut gates: HashMap<String, Arc<Semaphore>> = HashMap::new();
        let mut last_minute = None;
        let mut last_reconcile = None;
        let mut last_subscription = None;
        let cookie_due = Arc::new(AtomicI64::new(0));
        let cookie_enabled = state.setting("XUEQIU_COOKIE_REFRESH") != "0";
        let cookie_interval = state
            .setting("XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS")
            .parse::<i64>()
            .ok()
            .filter(|v| *v >= 300)
            .unwrap_or(10_800);
        let cookie_retry = state
            .setting("XUEQIU_COOKIE_REFRESH_RETRY_SECONDS")
            .parse::<i64>()
            .ok()
            .filter(|v| *v >= 60 && *v <= cookie_interval)
            .unwrap_or(300);
        let mut first = true;
        loop {
            tokio::select! {
                changed=stopping.changed()=> {if changed.is_err()||*stopping.borrow(){break;}},
                Some(joined)=jobs.join_next(),if !jobs.is_empty()=>{if let Err(error)=joined {event("local-scheduler","task_panicked",json!({"error":error.to_string()}));}},
                _=interval.tick()=>{
                    let now=Utc::now();let millis=now.timestamp_millis();let minute=now.timestamp()/60;
                    let minute_changed=last_minute!=Some(minute);
                    let mut due:Vec<(String,Option<String>)>=Vec::new();
                    // Cron jobs begin at their next minute boundary, not on
                    // every process startup. Reconcile/subscription are immediate.
                    if minute_changed && !first {
                        for (expression,cron) in &schedules {if cron.matches(&now){due.push((format!("cron:{expression}"),Some(expression.clone())));}}
                    }
                    if ingest_enabled && ((first&&run_ingest_on_start)||(!first&&minute_changed&&ingest_cron.matches(&now.with_timezone(&chrono_tz::Asia::Shanghai)))){due.push(("ingest".into(),None));}
                    last_minute=Some(minute);
                    if last_reconcile!=Some(now.timestamp()/15) {last_reconcile=Some(now.timestamp()/15);due.push(("reconcile".into(),None));}
                    if !state.setting("SUB2ME_BASE_URL").is_empty()&&last_subscription!=Some(minute){last_subscription=Some(minute);due.push(("subscription".into(),None));}
                    if cookie_enabled&&millis>=cookie_due.load(Ordering::Relaxed){due.push(("cookie".into(),None));}
                    for (name,expression) in due {
                        let gate=gates.entry(name.clone()).or_insert_with(||Arc::new(Semaphore::new(1))).clone();
                        let Ok(permit)=gate.try_acquire_owned() else{continue;};
                        let state=state.clone();let cookie_due=cookie_due.clone();
                        jobs.spawn(async move {
                            let _permit=permit;let started=std::time::Instant::now();
                            let result=match name.as_str(){
                                "ingest"=>crate::knowledge::ingest_tick(&state).await,
                                "reconcile"=>Ok(reconcile(&state).await),
                                "subscription"=>crate::runtime_jobs::subscribe(&state).await,
                                "cookie"=>{
                                    let result=match crate::cookie_refresh::validate(&state).await {Ok(value)=>Ok(value),Err(_)=>crate::cookie_refresh::refresh(&state).await};
                                    cookie_due.store(Utc::now().timestamp_millis()+1000*if result.is_ok(){cookie_interval}else{cookie_retry},Ordering::Relaxed);
                                    result
                                },
                                _=>dispatch(&state,expression.as_deref().unwrap_or(""),millis).await,
                            };
                            match result {Ok(_)=>event("local-scheduler","completed",json!({"job":name,"duration_ms":started.elapsed().as_millis()})),Err(error)=>event("local-scheduler","failed",json!({"job":name,"duration_ms":started.elapsed().as_millis(),"error":error.to_string()}))}
                        });
                    }
                    first=false;
                }
            }
        }
        // No task abort on shutdown: allow accepted local writes and remote
        // observations to settle, preserving their durable recovery state.
        while let Some(joined) = jobs.join_next().await {
            if let Err(error) = joined {
                event(
                    "local-scheduler",
                    "shutdown_task_failed",
                    json!({"error":error.to_string()}),
                );
            }
        }
    });
    Ok(Scheduler { stop, task })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cron_fields_are_bounded_and_timezone_is_explicit() {
        let now = DateTime::parse_from_rfc3339("2026-10-29T12:15:00Z").unwrap();
        assert!(Cron::parse(FINANCE).unwrap().matches(&now));
        assert!(!Cron::parse(MACRO).unwrap().matches(&now));
        assert!(
            Cron::parse("15 20 29 10 4")
                .unwrap()
                .matches(&now.with_timezone(&chrono_tz::Asia::Shanghai))
        );
        for invalid in [
            "*/0 * * * *",
            "60 * * * *",
            "* 24 * * *",
            "* * * *",
            "* * * * 8",
            "17-1 * * * *",
        ] {
            assert!(Cron::parse(invalid).is_err(), "{invalid}");
        }
    }
}
