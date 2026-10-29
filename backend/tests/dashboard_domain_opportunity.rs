use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};
use stock_info_local::dashboard::domain;

fn assert_equivalent(actual: &Value, expected: &Value, path: &str) {
    if let (Some(a), Some(b)) = (actual.as_f64(), expected.as_f64()) {
        assert!(
            (a - b).abs() <= 1e-10_f64.max(b.abs() * 1e-12),
            "{path}: {a} != {b}"
        );
        return;
    }
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}: object fields differ"
            );
            for (key, value) in b {
                assert_equivalent(&a[key], value, &format!("{path}.{key}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length differs");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_equivalent(a, b, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn opportunity_full_payload_matches_typescript_across_policy_gates() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let script = r#"
import { readFileSync } from 'node:fs';
import { buildInvestmentOpportunity, priceOpportunityMetrics } from './src/modules/research/domain/investment-opportunity.ts';
const policy=JSON.parse(readFileSync('./config/investment-opportunity-policy.json','utf8'));
const now=Date.parse('2026-10-28T12:00:00Z');
const dates=[];
for(let time=now;dates.length<253;time-=86400000){ const d=new Date(time);if(![0,6].includes(d.getUTCDay()))dates.unshift(d.toISOString().slice(0,10)); }
const bars=dates.map((date,i)=>({date,close:i===252?60:100,fq:'qfq',source:'xueqiu'}));
const points=[{reportDate:'2026-06-30',quarterRevenue:120,quarterNetProfit:30,ttmNetProfit:100,revenueYoY:.1,netProfitYoY:.2,provisional:false},{reportDate:'2026-03-31',quarterRevenue:100,quarterNetProfit:25,ttmNetProfit:90,revenueYoY:.12,netProfitYoY:.3,provisional:false},{reportDate:'2024-06-30',ttmNetProfit:64,revenueYoY:.1,netProfitYoY:.2,provisional:false}];
const assessment={status:'fair_low',confidence:'medium',method:'PE(TTM)',current:12,unit:'multiple',history:{metric:'PE(TTM)',windows:[{years:3,percentile:.2},{years:5,percentile:.2}]},quote:{date:'2026-10-28',source:'xueqiu'},operating:{ttmGrowth:.25}};
const base={policy,now,assessment,archetype:'growth_manufacturing',blockReasons:[],points,adjustedBars:bars,cashflowTtm:100,cashflowReportDate:'2026-06-30',debtRatio:.4,balanceReportDate:'2026-06-30'};
const cases=[];
function add(label,override={}){const input={...structuredClone(base),...override};cases.push({label,input,expected:buildInvestmentOpportunity(input)});}
add('base');
for(const archetype of ['bank','insurer','broker','property_operator','cyclical_commodity','stable_cash_dividend','exchange','pre_profit_milestone','software_platform','other'])add('archetype-'+archetype,{archetype});
for(const cashflowTtm of [null,-1,0,20,79.99,80,200])add('cashflow-'+cashflowTtm,{cashflowTtm});
for(const debtRatio of [null,0,.8,.8001,.9])add('debt-'+debtRatio,{debtRatio});
for(const cashflowReportDate of [null,'2025-12-31'])add('cash-period-'+cashflowReportDate,{cashflowReportDate});
for(const balanceReportDate of [null,'2025-01-01','2027-01-01','bad'])add('balance-period-'+balanceReportDate,{balanceReportDate});
for(const field of ['quarterRevenue','quarterNetProfit','revenueYoY','netProfitYoY','ttmNetProfit'])for(const value of [null,-5,0,.05,1,50]){
  const rows=structuredClone(points);rows[0][field]=value;add(`point0-${field}-${value}`,{points:rows});
  const previous=structuredClone(points);previous[1][field]=value;add(`point1-${field}-${value}`,{points:previous});
}
for(const status of ['undervalued','fair_low','fair','expensive','very_expensive','unknown'])add('status-'+status,{assessment:{...assessment,status}});
for(const ttmGrowth of [null,-.3,0,.19,.2,.25])add('ttm-'+ttmGrowth,{assessment:{...assessment,operating:{ttmGrowth}}});
for(const date of [null,'bad','2025-01-01','2027-01-01','2026-10-20','2026-10-21','2026-10-29','2026-10-30'])add('quote-'+date,{assessment:{...assessment,quote:{date}}});
add('no-assessment',{assessment:null});
for(const method of [null,'PB','PE(TTM) primary','FCF Yield'])add('method-'+method,{assessment:{...assessment,method}});
for(const percentile of [null,.199,.2,.201,.8])add('percentile-'+percentile,{assessment:{...assessment,history:{metric:'PE(TTM)',windows:[{years:3,percentile},{years:5,percentile}]}}});
add('one-history',{assessment:{...assessment,history:{metric:'PE(TTM)',windows:[{years:3,percentile:.1}]}}});
for(const reason of ['earnings_shrinking','no_available_band','no_market_cap_band','currency_mismatch','quote_fetch_failed','financial_refresh_failed','stale_quote'])add('block-'+reason,{blockReasons:[reason]});
for(const rows of [[],points.slice(0,1),points.slice(0,2),[points[0],{...points[1],reportDate:'2025-12-31'}],[...points,points[0]],points.map((r,i)=>({...r,provisional:i===0}))])add('rows-'+cases.length,{points:rows});
for(const patch of [{fq:'normal'},{source:'other'},{date:'bad'},{close:null},{close:0}])add('bars-'+JSON.stringify(patch),{adjustedBars:bars.map((b,i)=>i===252?{...b,...patch}:b)});
for(const adjustedBars of [[],bars.slice(-30),bars.slice(0,252).concat(bars[251]),bars.map(b=>({...b,close:100}))])add('price-window-'+cases.length,{adjustedBars});
for(const shift of [-365,365])add('price-shift-'+shift,{adjustedBars:bars.map(b=>({...b,date:new Date(Date.parse(b.date)+shift*86400000).toISOString().slice(0,10)}))});
const seasonal=[{...points[0],quarterRevenue:90,quarterNetProfit:22.5},points[1],...[2025,2024,2023].flatMap(year=>[{...points[0],reportDate:`${year}-06-30`,quarterRevenue:80,quarterNetProfit:20,ttmNetProfit:64},{...points[1],reportDate:`${year}-03-31`,quarterRevenue:100,quarterNetProfit:25}])];
for(const revenue of [-1,0,70,74.99,75,90,100,101])add('seasonal-revenue-'+revenue,{points:seasonal.map((q,i)=>i===0?{...q,quarterRevenue:revenue}:q)});
add('seasonal-duplicate',{points:[...seasonal,seasonal[0]]});
add('seasonal-missing',{points:seasonal.map((q,i)=>i>3?{...q,provisional:true}:q)});
add('seasonal-mixed',{points:seasonal.map(q=>q.reportDate==='2025-06-30'?{...q,quarterRevenue:110}:q)});
const cross=[2026,2025,2024,2023].flatMap(year=>[{...points[0],reportDate:`${year}-03-31`,quarterRevenue:80,quarterNetProfit:20,ttmNetProfit:year===2026?100:64},{...points[1],reportDate:`${year-1}-12-31`,quarterRevenue:100,quarterNetProfit:25}]);
add('seasonal-cross-year',{points:cross,now:Date.parse('2026-06-01T12:00:00Z'),cashflowReportDate:'2026-03-31',balanceReportDate:'2026-03-31',assessment:{...assessment,quote:{date:'2026-06-01'}}});
for(const status of ['draft','reviewed','invalidated'])for(const nextReview of ['',null,'bad','2026-10-01','2026-10-28','2026-10-29','2026-10-28T00:00:00Z'])add('thesis-'+status+'-'+nextReview,{thesisReview:{status,nextReview}});
for(const archetype of ['bank','growth_manufacturing','cyclical_commodity','pre_profit_milestone'])for(const state of ['pass','fail','unknown'])add('industry-'+archetype+'-'+state,{archetype,industry:{version:'fixture',archetype,state,checks:[{state:'fail',label:'risk'}],caveat:'fixture'}});
const forward={model:{status:'available',impliedGrowth:.12,scenarios:[{name:'base',margin:.2}],caveats:[]},priceDate:'2026-10-28',profitPeriod:'2026-06-30',currency:'CNY',researchVersion:2};
add('forward-base',{forward});add('forward-stale',{forward:{...forward,priceDate:'2026-10-27'}});add('forward-empty',{forward:{...forward,model:{...forward.model,scenarios:[]}}});add('forward-negative',{forward:{...forward,model:{...forward.model,scenarios:[{name:'base',margin:-.1}]}}});
let seed=2147483647;const random=()=>{seed=(seed*48271)%2147483647;return seed/2147483647};
for(let i=0;i<150;i++){
  const rows=structuredClone(points);rows[0].quarterRevenue=20+random()*150;rows[0].quarterNetProfit=5+random()*50;rows[0].ttmNetProfit=20+random()*150;rows[0].revenueYoY=random()*.8-.2;rows[0].netProfitYoY=random()*.8-.2;
  const input={points:rows,cashflowTtm:random()*180-20,debtRatio:random(),assessment:{...assessment,operating:{ttmGrowth:random()*.8-.2},history:{metric:'PE(TTM)',windows:[{years:3,percentile:random()},{years:5,percentile:random()}]}}};add('seeded-'+i,input);
}
process.stdout.write(JSON.stringify(cases));
"#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .current_dir(root)
        .output()
        .expect("Node development test runner required for TS/Rust differential");
    assert!(
        output.status.success(),
        "fixture runner: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert!(cases.len() > 300, "expected full gate matrix");
    for case in &cases {
        let actual = domain::opportunity(&case["input"]);
        assert_equivalent(&actual, &case["expected"], case["label"].as_str().unwrap());
    }
}

#[test]
fn conservative_valuation_boundary_and_missing_inputs() {
    for (cap, expected) in [
        (79.0, "undervalued"),
        (80.0, "fair_low"),
        (129.0, "fair_low"),
        (130.0, "fair"),
        (180.0, "fair"),
        (216.0, "expensive"),
        (217.0, "very_expensive"),
        (-1.0, "unknown"),
    ] {
        assert_eq!(domain::band_position(cap, 80.0, 180.0), expected);
    }
    let input = json!({"result":{"verdict":"watch","basis":{"key":"pe_ttm"},"position":{"marketCap":100},"growth":{"verdict":"supports","ttmGrowth":0.1},"note":"fixture"},"bands":{"bands":[{"key":"pe_ttm","label":"PE","role":"primary","status":"available","unit":"multiple","range":{"low":8,"high":18},"denominator":{"value":10,"reportDate":"2026-06-30"},"assumptions":[]}],"warnings":[]},"series":{"points":[]},"statements":[],"bars":[],"quote":null,"historyComparable":true});
    assert_eq!(domain::assess(&input)["conservativeMargin"], -0.25);
    let mut yield_input = input.clone();
    yield_input["result"]["basis"]["key"] = json!("fcf_yield");
    yield_input["bands"]["bands"][0]["key"] = json!("fcf_yield");
    yield_input["bands"]["bands"][0]["unit"] = json!("percent");
    yield_input["bands"]["bands"][0]["range"] = json!({"low":3,"high":6});
    assert!(
        (domain::assess(&yield_input)["conservativeMargin"]
            .as_f64()
            .unwrap()
            - 0.4)
            .abs()
            < 1e-12
    );
}
