//! Differential acceptance against the original, still-supported TypeScript domain.
//! No providers, database, current wall clock or fabricated model outputs are used.
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};
use stock_info_local::dashboard::{domain, point_in_time};

fn equivalent(actual: &Value, expected: &Value, path: &str) {
    if let (Some(a), Some(b)) = (actual.as_f64(), expected.as_f64()) {
        assert!(
            (a - b).abs() <= 1e-12_f64.max(b.abs() * 1e-12),
            "{path}: {a} != {b}"
        );
        return;
    }
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}: fields"
            );
            for (key, value) in b {
                equivalent(&a[key], value, &format!("{path}.{key}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: length");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                equivalent(a, b, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn screen_assessment_and_knowledge_time_match_original_domain() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let script = r#"
import {screenValuationCandidate as screen} from './src/modules/research/domain/valuation-screen.ts';
import {assessValuation as assess} from './src/modules/research/domain/valuation-assessment.ts';
import {buildPointInTimePeSeries as pit} from './src/modules/research/domain/point-in-time-pe.ts';
const cases=[];
function add(op,input){let expected=op==='pit'?pit(input.statements,input.marketCaps,{ceiling:300}):op==='screen'?screen(input):assess(input);if(op==='assess')delete expected.computedAt;cases.push({op,input,expected});}
const band={key:'pe_ttm',role:'primary',label:'PE(TTM)',status:'available',unit:'multiple',range:{low:8,high:18},denominator:{basis:'net_income_ttm',value:10000000,reportDate:'2026-06-30'},assumptions:[]};
const base={code:'600036.SH',archetype:'growth_manufacturing',bands:[band],bandCurrency:'CNY',quote:{currency:'CNY',priceAsOf:'2026-08-01',marketCap:100000000}};
function s(change){const input=structuredClone(base);change(input);add('screen',input);}
// Include exact binary decimal midpoint: JS toFixed is not Rust's ties-to-even formatter.
for(const cap of [0,-1,79999999,80000000,112500000,144000000,144000001,180000000,180000001])s(x=>x.quote.marketCap=cap);
for(const currency of ['RMB','人民币','HKD','USD','unknown',null])s(x=>x.quote.currency=currency);
for(const age of ['2026-07-01','2026-10-28','2026-10-29','2025-01-01',null])s(x=>x.quote.priceAsOf=age);
for(const growth of [-.151,-.15,-.149,0,null])s(x=>x.growth={ttmGrowth:growth,reportDate:'2026-06-30',provisional:false});
for(const role of ['primary','auxiliary'])for(const key of ['pe_ttm','pb','ev_ebit','fcf_yield'])s(x=>{x.bands[0].key=key;x.bands[0].role=role;});
for(const cap of [100000000,150000000,200000000,300000000])s(x=>{x.quote.marketCap=cap;x.bands[0].key='fcf_yield';x.bands[0].unit='percent';x.bands[0].range={low:3,high:6};});
s(x=>x.quote=null);s(x=>x.bands=[]);s(x=>x.bands[0].status='unavailable');s(x=>x.bands[0].denominator.value=0);
s(x=>{const auxiliary=structuredClone(x.bands[0]);auxiliary.role='auxiliary';auxiliary.key='pb';x.bands=[auxiliary,x.bands[0]]});
const assessment={result:{verdict:'watch',basis:{key:'pe_ttm'},position:{marketCap:100000000},growth:{verdict:'supports',ttmGrowth:.1},note:'fixture'},bands:{bands:[band],warnings:['fixture warning']},series:{points:[]},statements:[],bars:[],quote:{date:'2026-08-01',source:'fixture'},historyComparable:true};
for(const cap of [79999999,80000000,129999999,130000000,180000000,216000000,216000001]){const x=structuredClone(assessment);x.result.position.marketCap=cap;add('assess',x);}
for(const flag of ['blocked','auxiliary','missing-basis','missing-range','missing-quote','unknown-growth','yield','uncomparable']){const x=structuredClone(assessment);if(flag==='blocked')x.result.verdict='blocked';if(flag==='auxiliary')x.bands.bands[0].role='auxiliary';if(flag==='missing-basis')x.result.basis=null;if(flag==='missing-range')x.bands.bands[0].range=null;if(flag==='missing-quote')x.quote=null;if(flag==='unknown-growth')x.result.growth={verdict:'unknown',ttmGrowth:null};if(flag==='yield'){x.bands.bands[0].unit='percent';x.bands.bands[0].range={low:3,high:6};}if(flag==='uncomparable')x.historyComparable=false;add('assess',x);}
function row(report,notice,value,period,contract='eastmoney_f10_income.v1'){return {reportDate:report,statementType:'income',fiscalPeriod:period,payload:{PARENT_NETPROFIT:value,NOTICE_DATE:notice,FISCAL_PERIOD:period,FINANCIAL_SOURCE_CONTRACT:contract}};}
const rows=[row('2024-03-31','2024-06-01',100,'FY','eastmoney_f10_annual_income.v1'),row('2024-06-30','2024-08-01',30,'3M'),row('2025-03-31','2025-06-01',120,'FY','eastmoney_f10_annual_income.v1'),row('2025-06-30','2025-08-01',40,'3M')];
const caps=['2025-05-31','2025-06-01','2025-07-31','2025-08-01'].map(date=>({date,marketCap:1300}));
for(const variant of ['baseline','no-notice','no-contract','negative','duplicate','no-annual','zero-cap','ceiling']){let statements=structuredClone(rows),marketCaps=structuredClone(caps);if(variant==='no-notice')delete statements[3].payload.NOTICE_DATE;if(variant==='no-contract')delete statements[3].payload.FINANCIAL_SOURCE_CONTRACT;if(variant==='negative')statements[3].payload.PARENT_NETPROFIT=-1000;if(variant==='duplicate')statements.push(structuredClone(statements[3]));if(variant==='no-annual')statements=statements.filter(r=>r.fiscalPeriod!=='FY');if(variant==='zero-cap')marketCaps[3].marketCap=0;if(variant==='ceiling')marketCaps[3].marketCap=100000000;add('pit',{statements,marketCaps});}
process.stdout.write(JSON.stringify(cases));
"#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .current_dir(root)
        .output()
        .expect("Node development runner required for original TS differential");
    assert!(
        output.status.success(),
        "TS fixtures: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert!(cases.len() >= 65, "full gate matrix must execute");
    for (i, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let actual = match case["op"].as_str().unwrap() {
            "screen" => domain::screen(input),
            "assess" => {
                let mut value = domain::assess(input);
                value.as_object_mut().unwrap().remove("computedAt");
                value
            }
            "pit" => json!(point_in_time::build(
                input["statements"].as_array().unwrap(),
                input["marketCaps"].as_array().unwrap(),
                300.0
            )),
            _ => unreachable!(),
        };
        equivalent(
            &actual,
            &case["expected"],
            &format!("case {i} {}", case["op"]),
        );
    }
}
