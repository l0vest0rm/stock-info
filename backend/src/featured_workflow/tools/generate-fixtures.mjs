// Development-only differential evidence. Never imported by the Rust runtime.
import {selectTranslationSource,addOmissionPlaceholders} from '../../../../scripts/lib/featured-report-selection.mjs';
import {planTranslationBatches,estimateTranslationTokens} from '../../../../scripts/lib/featured-report-batches.mjs';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const titles=['Risk factors','Legal','Disclosures','Important disclosures','Disclaimer','General Disclosures','法律声明','分析师认证','Disclosure Appendix','Conflicts of interest','Copyright Notice'];
const texts=['Substantive research revenue grew 12% to 1,234 dollars.','This report does not constitute investment advice.','New regulation increases costs and litigation risk.','This material is for informational purposes only.','本报告不构成投资建议。','未经本报告出版方授权不得复制、转载或传播。','Our firm does and seeks to do business and has conflict of interest that affects objectivity of this research.','Copyright 2026 Research Inc.'];
const cases=[];
for(const title of titles)for(const original of texts){
const source={pageCount:1,sections:[{id:'s1',title,blocks:[{id:'b1',original,sourceLocations:[{page:1,bbox:[.1,.1,.8,.3]}]}]}]};
const {source:selected,skipped}=selectTranslationSource(source);
const translated=selected.sections.map(s=>({...s,blocks:s.blocks.map(b=>({id:b.id,translation:'翻译',sourceLocations:b.sourceLocations}))}));
cases.push({source,selected,skipped,restored:addOmissionPlaceholders(source,translated),batches:planTranslationBatches(selected)});
}
const prompt='instructions\n中文';
const blocks=[{id:'b1',original:'Revenue grew 12% 中文',sectionTitle:'Research'}];
const inputs=[
 ['whole',{blocks}],
 ['glossary',[{title:'Research',sample:'Revenue grew 12%'}]],
 ['translate',{glossary:{terms:[{source:'revenue',target:'营收'}]},context:{previous:'earlier',next:'later'},blocks}],
 ['summary',[{digest:'Revenue grew 12%'}]],
 ['summary',[{title:'Research',digest:'Revenue grew 12%'}]],
];
const cacheKeys=inputs.map(([kind,input])=>({kind,prompt,input,key:createHash('sha256').update(JSON.stringify({model:'gpt-5.6-luna',prompt,input})).digest('hex')}));
writeFileSync(new URL('../../../tests/fixtures/featured-workflow-domain.json',import.meta.url),JSON.stringify({cases,cacheKeys,tokens:['abc中文','😀abc','Hello world','中文测试',''].map(text=>({text,tokens:estimateTranslationTokens(text)}))},null,2)+'\n');
