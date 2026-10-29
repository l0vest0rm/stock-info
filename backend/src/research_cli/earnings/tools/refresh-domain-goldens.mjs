// Test tooling only: regenerate expected outputs using the original reference.
// Never invoked by the Rust application or a supported business workflow.
import {readFileSync,writeFileSync} from 'node:fs';
import * as reference from '../../../../../scripts/lib/earnings-research.mjs';
const path=new URL('../domain-goldens.json',import.meta.url);
const cases=JSON.parse(readFileSync(path,'utf8'));
for(const c of cases){
  c.events=reference.aggregateEarningsEvents(c.performance,c.forecasts,{asOf:c.asOf,fromDate:c.from,reportDate:c.reportDate});
  c.prioritized=reference.prioritizeEarningsEvents(c.events,20);
  c.attached=reference.attachMarketsAndFilter(c.prioritized,c.markets,c.filters);
  c.analyzed=c.attached.map(candidate=>reference.analyzeCandidate(candidate,c.statements,{asOf:c.asOf,forecastYear:2027,ranking:c.ranking}));
  c.ranked=reference.rankAnalyzedCandidates(c.analyzed,c.ranking);
  c.expected=c.ranked.map(candidate=>reference.attachConsensus(candidate,c.consensus));
  c.payload={asOf:c.asOf,reportDate:c.reportDate,fromDate:c.from,baseUrl:'http://127.0.0.1:8000',candidates:c.expected,stats:{futureRowsExcluded:1}};
  c.expectedMarkdown=reference.renderEvidenceMarkdown(c.payload);
}
writeFileSync(path,JSON.stringify(cases));
console.log(`Refreshed ${cases.length} original earnings domain/render contracts.`);
