import test from 'node:test';
import assert from 'node:assert/strict';
import { currentInvestmentGate, evaluateInvestmentRelevance as decide } from './information-feed-relevance.mjs';

test('clear social news is rejected before extraction', () => {
  for (const [title, body] of [
    ['中国队获得亚运会女子篮球铜牌', '中国队在女子篮球比赛中获得铜牌。'],
    ['大熊猫平平已启程赴美', '大熊猫平平已启程赴美。'],
    ['韩正会见塞浦路斯总统', '韩正会见塞浦路斯总统，双方强调友好关系。'],
    ['四川某地发生地震', '四川某地发生地震，暂未发现人员伤亡。'],
    ['巴基斯坦发生爆炸致人遇难', '巴基斯坦西北部发生爆炸，造成11人遇难。'],
    ['南部战区组织海空联合演训', '南部战区在相关海域组织海空联合演训。'],
    ['我国著名音乐家刘欢病逝', '学校发布讣告，音乐家刘欢病逝，享年63岁。'],
    ['上海市气象台发布中心城区雷电黄色预警', '气象台提醒市民防范雷电天气。'],
    ['欧盟向撒哈拉以南非洲提供人道主义援助', '援助用于难民、流离失所者的卫生保健。预算获批后实施。'],
    ['俄称控制多个居民点 乌称发动多次进攻', '俄乌军方分别通报战区进展。'],
    ['古巴外长：美持续对古封锁是集体惩罚', '外长在联合国谴责封锁造成的人道主义危机。'],
  ]) assert.equal(decide({ title, body }).effectiveDisposition, 'reject', title);
});

test('economic facts override superficially irrelevant headlines', () => {
  for (const [title, body] of [
    ['某公司厂房发生火灾', '某公司厂房发生火灾后停产，产能暂时下降。'],
    ['油气管道停运', '天然气管道关闭，供应中断。'],
    ['中美会见', '中美会见后达成关税下调安排。'],
    ['央行宣布降息', '央行下调利率。'],
    ['霍尔木兹海峡关闭', '霍尔木兹海峡关闭，原油运输受阻。'],
    ['中国香港消费者价格指数上涨', '中国香港8月消费者价格指数同比上涨1.7%。'],
    ['OpenAI扩大网络访问权限', 'OpenAI扩大对乌克兰的网络访问权限，用于民用防御。'],
    ['微软股价上涨3%', '微软股价上涨3%，公司推出新版Copilot。'],
    ['巴斯夫股价下跌', '巴斯夫提出合并方案后股价下跌。'],
    ['Dropbox股价下跌', '花旗将Dropbox评级从中性下调至卖出，股价盘前下跌。'],
    ['美元指数上涨', '初请失业金数据公布后美元指数上涨。'],
    ['某上市公司厂房遭台风袭击', '公司被迫停产，预计本季度产能下降。'],
    ['对非洲出口企业的关税调整', '欧盟下调相关商品进口关税，企业订单预计增长。'],
    ['俄称击落无人机 多处工业设施遭袭受损', '军方称多处工业设施受损，影响尚待评估。'],
  ]) assert.equal(decide({ title, body }).effectiveDisposition, 'pass', title);
});

test('price-only dispatch is rejected; unknown and long mixed content fail open', () => {
  assert.equal(decide({ title: '国际原油期货结算价收跌', body: '国际原油期货结算价收跌2%。' }).decision, 'reject');
  assert.equal(decide({ title: '新型技术获得进展', body: '一项新型技术获得进展。' }).decision, 'uncertain');
  assert.equal(decide({ title: '比赛结果', body: '球队战胜对手。' + '这篇长文还可能有未识别的重要信息。'.repeat(60) }).decision, 'uncertain');
});

test('relevant story updates stay eligible and decisions bind to exact inputs', () => {
  const input = { title: '后续进展', body: '此前交易已经取消。', kind: 'update', previousStoryRelevant: true };
  const decision = decide(input);
  assert.equal(decision.decision, 'pass');
  assert.equal(currentInvestmentGate(decision, input), true);
  assert.equal(currentInvestmentGate(decision, { ...input, body: input.body + '变更' }), false);
});
