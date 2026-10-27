#!/usr/bin/env node
// Validate the public daily research snapshot. No request, scraping or trading is performed here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const universe = JSON.parse(readFileSync(resolve(root, 'config/investment-universe.json'), 'utf8'))
const report = JSON.parse(readFileSync(resolve(root, 'config/investment-daily-report.json'), 'utf8'))
const companyIds = new Set(universe.companies.map(c => c.id))
const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
const required = (s,label) => assert(typeof s === 'string' && s.trim().length > 0,'Missing '+label)
const list = (v,label) => assert(Array.isArray(v),'Array required: '+label)
const unique = (arr,label) => assert(new Set(arr).size===arr.length,'Duplicate '+label)
function source(s,label){
  assert(s && typeof s === 'object',label+' missing')
  required(s.title,label+'.title')
  assert(typeof s.url==='string' && /^https:\/\/[^/\s?#]+(?:[/?#][^\s]*)?$/i.test(s.url),label+'.url must use HTTPS')
  assert(date(s.publishedAt),label+'.publishedAt must have source date')
  assert(['issuer','exchange','regulator','financial_filing','industry','other'].includes(s.kind),label+'.kind')
}
function sources(items,label,requiredCount=0){
  list(items,label)
  assert(items.length>=requiredCount,label+' lacks cited sources')
  items.forEach((s,i)=>source(s,label+'['+i+']'))
}
assert.equal(report.schemaVersion,1)
assert.equal(report.type,'public_research_review')
assert.equal(report.restrictions.containsOwnerHoldings,false)
assert.equal(report.restrictions.automaticTrading,false)
assert.equal(report.marketFocus,'A_share_first')
assert(['not_reviewed','partial','complete'].includes(report.status),'Unknown review status')
assert(date(report.universeAsOf),'Invalid universe reference date')
assert.equal(report.universeAsOf,universe.asOf,'Universe version mismatch; rebase report before publishing new data')
assert(report.coverage && typeof report.coverage==='object','coverage required')
for(const key of ['checkedCompanyIds','unavailableCompanyIds']){
  const values=report.coverage[key]
  list(values,'coverage.'+key)
  unique(values,'coverage.'+key)
  for (const id of values)assert(companyIds.has(id),'Unknown coverage ID: '+id)
}
list(report.coverage.checks,'coverage.checks')
unique(report.coverage.checks.map(check=>check.companyId),'coverage.check company ID')
for(const check of report.coverage.checks){
  assert(companyIds.has(check.companyId),'Coverage evidence points outside universe')
  assert(date(check.checkedAt),'Coverage check date required')
  sources(check.sources,'coverage.check.sources',1)
}
const checked=new Set(report.coverage.checkedCompanyIds)
assert.equal(checked.size,report.coverage.checks.length,'Coverage checked IDs require one evidence check each')
for(const check of report.coverage.checks) assert(checked.has(check.companyId),'Evidence check ID not declared checked')
for(const id of report.coverage.unavailableCompanyIds)assert(!checked.has(id),'Same company marked checked and unavailable: '+id)
for(const key of ['materialChanges','assessments','rotationComparisons','gaps'])list(report[key],key)
for(const gap of report.gaps)required(gap,'unresolved gap')
if(report.status==='not_reviewed'){
  assert.equal(report.reportDate,null,'Unreviewed report may not have a date')
  assert.equal(report.generatedAt,null,'Unreviewed report may not claim generation time')
  assert.equal(report.coverage.checkedCompanyIds.length,0)
  assert.equal(report.coverage.checks.length,0)
  assert.equal(report.coverage.unavailableCompanyIds.length,0)
  assert.equal(report.materialChanges.length,0)
  assert.equal(report.assessments.length,0)
  assert.equal(report.rotationComparisons.length,0)
  assert.equal(report.summary,'')
}else{
  assert(date(report.reportDate),'Reviewed report must declare a valid date')
  assert(typeof report.generatedAt==='string' && !Number.isNaN(Date.parse(report.generatedAt)),'Reviewed report must declare generatedAt ISO timestamp')
  required(report.summary,'summary')
  assert(checked.size+report.coverage.unavailableCompanyIds.length>0,'Review must declare assessed or unavailable companies')
  if(report.status==='complete'){
    assert.equal(checked.size,universe.companies.length,'Complete status requires evidence checks for every company')
    assert.equal(report.coverage.unavailableCompanyIds.length,0,'Complete status cannot omit unavailable companies')
  }
}
for(const [i,item] of report.materialChanges.entries()){
  const p='materialChanges['+i+']'
  assert(companyIds.has(item.companyId),p+' unknown company')
  assert(checked.has(item.companyId),p+' company not checked')
  assert(date(item.eventDate),p+' eventDate invalid')
  for(const field of ['change','expectationDifference','potentialImpact','uncertainty'])required(item[field],p+'.'+field)
  sources(item.sources,p+'.sources',1)
}
const permitted=['consider_buy','consider_add','research_hold','consider_trim','consider_exit','watch','insufficient_data']
const buying=new Set(['consider_buy','consider_add'])
for(const [i,item] of report.assessments.entries()){
  const p='assessments['+i+']'
  assert(companyIds.has(item.companyId),p+' unknown company')
  assert(checked.has(item.companyId),p+' company not checked')
  assert(permitted.includes(item.action),p+' invalid action')
  assert(date(item.assessedAt),p+' assessedAt invalid')
  for(const field of ['thesis','expectationDifference','risk','validationNeeded'])required(item[field],p+'.'+field)
  assert(['high','medium','low'].includes(item.confidence),p+' invalid confidence')
  sources(item.sources,p+'.sources',1)
  if(buying.has(item.action)){
    const v=item.valuation
    assert(v && typeof v==='object',p+' buy/add requires dated valuation')
    assert(date(v.priceAsOf),p+' priceAsOf required')
    assert(typeof v.marketPrice==='number' && v.marketPrice>0 && Number.isFinite(v.marketPrice),p+' observedPrice required')
    assert(v.currency && ['CNY','HKD','USD','KRW'].includes(v.currency),p+' currency required')
    required(v.valuationMethod,p+'.valuationMethod')
    assert(Number.isFinite(v.conservativeValueLow)&&Number.isFinite(v.conservativeValueHigh)&&v.conservativeValueLow>0&&v.conservativeValueHigh>=v.conservativeValueLow,p+' conservative range required')
    assert(v.marketPrice<=v.conservativeValueHigh,p+' price outside conservative upside range; re-evaluate action')
    required(v.expectedReturnRationale,p+'.expectedReturnRationale')
    sources(v.sources,p+'.valuation.sources',1)
  }
}
unique(report.assessments.map(x=>x.companyId),'daily company assessments')
for(const [i,item] of report.rotationComparisons.entries()){
  const p='rotationComparisons['+i+']'
  assert(companyIds.has(item.fromCompanyId)&&companyIds.has(item.toCompanyId),p+' invalid company')
  assert(item.fromCompanyId!==item.toCompanyId,p+' identical company')
  assert(checked.has(item.fromCompanyId)&&checked.has(item.toCompanyId),p+' unreviewed company')
  for(const field of ['rationale','fundingMarket','opportunityCost','factorConcentrationImpact','executionGaps'])required(item[field],p+'.'+field)
  assert(item.portfolioPositionConfirmed===false,p+' owner holdings are private, comparison must be hypothetical')
  sources(item.sources,p+'.sources',1)
}
if(report.status!=='not_reviewed'){
  for(const i of report.assessments)assert(i.assessedAt<=report.reportDate,'Assessment date later than report date')
}
const counts={universe:universe.companies.length,checked:checked.size,unavailable:report.coverage.unavailableCompanyIds.length,materialChanges:report.materialChanges.length,assessments:report.assessments.length,comparisons:report.rotationComparisons.length}
console.log('Daily review valid: '+JSON.stringify({status:report.status,date:report.reportDate,counts}))
