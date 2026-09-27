import test from 'node:test';
import assert from 'node:assert/strict';
import { currentInvestmentGate, evaluateInvestmentRelevance as decide } from './information-feed-relevance.mjs';

test('listed companies across four markets require a business event', () => {
  for (const [title, body, reason] of [
    ['宁德时代发布新一代电池', '公司发布新产品并扩产。', 'listed_a_share'],
    ['腾讯控股上半年营收增长', '公司营收同比增长。', 'listed_hong_kong'],
    ['英伟达宣布新GPU订单', 'NVIDIA订单增长。', 'listed_us'],
    ['SK海力士HBM订单增长', 'SK海力士订单同比增长。', 'listed_korea'],
  ]) {
    const result = decide({ title, body });
    assert.equal(result.decision, 'pass', title);
    assert.deepEqual(result.reasonCodes, [reason]);
  }
});

test('private stars, strategic industries and macro decisions are admitted', () => {
  for (const [title, body, reason] of [
    ['Anthropic完成新一轮融资', '公司融资150亿美元。', 'private_company'],
    ['宇树科技推出新款人形机器人', '公司发布新产品。', 'private_company'],
    ['光模块出货量同比增长', '800G光模块出货量增长。', 'industry'],
    ['阿曼：霍尔木兹海峡通航安排谈判推进', '霍尔木兹海峡通航谈判取得进展。', 'industry'],
    ['国产火箭总装周期缩至15天', '商业火箭总装周期缩短，生产效率提高。', 'industry'],
    ['中国工商银行承销熊猫债', '中国工商银行牵头承销新一期熊猫债。', 'industry'],
    ['美联储宣布加息', '美联储加息25个基点。', 'macro_central_bank'],
    ['美国CPI同比增长', '美国CPI公布后同比增长。', 'macro_economic_data'],
  ]) assert.deepEqual(decide({ title, body }).reasonCodes, [reason], title);
});

test('whitelist misses and price-only news are rejected even for long articles', () => {
  for (const [title, body] of [
    ['中国队获得亚运会篮球铜牌', '篮球比赛夺冠。'],
    ['某公司宣布重大合同', '未指明白名单公司。'],
    ['新型技术获得进展', '技术进展。'.repeat(300)],
    ['Meta股价上涨3%', 'Meta股价上涨3%，总市值报1.9万亿美元。'],
    ['全国铁路预计发送旅客1300万人次', '旅客量增长。'],
    ['布伦特原油期货跌超3%', '布伦特原油期货价格跌3%，报97美元。'],
  ]) assert.equal(decide({ title, body }).decision, 'reject', title);
});

test('relevant story updates stay eligible and decisions bind to exact inputs', () => {
  const input = { title: '后续进展', body: '此前交易已经取消。', kind: 'update', previousStoryRelevant: true };
  const decision = decide(input);
  assert.equal(decision.decision, 'pass');
  assert.equal(currentInvestmentGate(decision, input), true);
  assert.equal(currentInvestmentGate(decision, { ...input, body: input.body + '变更' }), false);
});
