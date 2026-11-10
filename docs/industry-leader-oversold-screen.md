# 全 A 行业龙头「超跌 + 估值合理 + 反弹条件」筛选

研究筛选工具，不是目标价、不是买卖指令、不构成收益预测。
历史分位便宜不等于内在低估；「有反弹条件」只是价格结构上的止跌迹象。

脚本：`scripts/analyze-a-share-industry-leaders.mjs`
回归：`scripts/tests/analyze-a-share-industry-leaders.test.mjs`

## 和观察池版本的区别

| | `analyze-track-leader-oversold.mjs` | `analyze-a-share-industry-leaders.mjs` |
| --- | --- | --- |
| 样本 | `config/investment-universe.json` 观察池（78 只 A 股） | 全 A 股，东财行业快照（约 5900 只） |
| 「龙头」定义 | 观察池内按市值排序 | 东财行业分组内按总市值排序 |
| 适用 | 已人工核验的细分赛道 | 想覆盖全市场、不想先维护名单 |

两者共用 `scripts/lib/oversold-metrics.mjs` 的 TTM / 单季 / RSI / 分位实现，
口径不会各写一套。

## 用法

```sh
npm run screen:industry-leaders            # 打印 Markdown
npm run screen:industry-leaders:report     # 同时写 reports/research/*.md 与 *.json
npm run screen:industry-leaders:offline    # 只用本地缓存，不联网
npm run check:industry-leaders             # 口径回归测试（不联网）

node scripts/analyze-a-share-industry-leaders.mjs --industry 半导体,白酒Ⅱ
node scripts/analyze-a-share-industry-leaders.mjs --limit-tracks 5      # 快速试跑
node scripts/analyze-a-share-industry-leaders.mjs --min-drawdown 0.35 --max-percentile-severe 0.15
```

全部参数见 `--help`。

## 数据来源与边界

| 用途 | 来源 | 说明 |
| --- | --- | --- |
| 行业归属、总市值 | 东财行情快照（`82.push2` `f100` / `f20`） | 只用于「谁是行业龙头」，不作为价格来源 |
| 日 K、PE(TTM)、PB | 雪球（唯一 A 股 K 线来源） | 前复权；Cookie 从本地凭据仓读取 |
| 利润表 | 东财 F10 `RPT_F10_FINANCE_*` | 与后端 `finance/providers.rs` 同家族 |

- 缺 Cookie、雪球人机验证、利润表缺失都会显式标 `blocked`，不静默降级、不换数据源。
- 财务缓存写在 `data/local/market-data/industry-income/`，**不写入**后端读取的
  `financial-statements/income/`，避免污染需要满足累计+年报合同校验的正式快照。
- 行业快照缓存在 `data/local/market-data/industry-snapshot/`。

## 四关 + 一层信号

1. **行业龙头**：东财行业分组内总市值 Top N（默认 3）；成员不足 `--min-members`
   或市值低于 `--min-market-cap` 的行业/个股被排除并留档，不按 0 参与排名。
2. **弱势**：252 日回撤 ≤ `-25%`、120 日仍下跌、RSI14 < 60（已反弹的不追）。
3. **估值合理**：权重指标（默认 PE(TTM)、PB）的**自身 5 年历史分位**
   - 严格档：全部 ≤ 20%
   - 宽松档：主指标 ≤ 20% 且次级指标 ≤ 35%
   - 只有严格档才算「过」，宽松档单独列出，不冒充便宜。
4. **盈利未恶化**：TTM 利润同比 ≥ 0%，且最新单季同比 ≥ -30%。
   加这一条是因为 TTM 是滚动四季，可能掩盖最近一个季度已经明显转差。
5. **反弹条件**：至少一个确认信号（RSI 超卖修复 / MACD 柱转正 / 站上 5 日线且低点抬高）。
   只有观察信号（仍在超卖区、抛压衰竭）的，进「等止跌信号」，不猜底。

判定结果分档：

| 状态 | 含义 |
| --- | --- |
| 四关全过 | 四关 + 确认信号同时成立 |
| 等止跌信号 | 其余都符合，但价格还没走出来 |
| 口径宽松待确认 | 只有次级估值指标超严格档 |
| 估值不便宜 | 跌得多、盈利还在，但分位不够低 |
| 单季转差 | TTM 还在增长，最近一个季度明显下滑 |
| 盈利恶化 | TTM 利润同比为负 |
| 不够弱势 | 跌幅或 RSI 没到位 |
| 缺数据 | K 线不足 260 根 / 财务缺失 / 行情落后 |

## 两个容易出错、已固化成测试的口径

**1. 累计报表 vs 单季度报表。**
东财同一份利润表会同时返回 `三季报`（累计，合同 `eastmoney_f10_income.v1`）和
`三季度`（单季，合同 `eastmoney_f10_incomeqc.v1`），`reportDate` 相同。
按日期排序区分不可靠，必须按合同/标签显式分类，否则会把单季利润当成累计利润，
TTM 和单季同比都会算错。

**2. 行情新鲜度用交易日，不用日历天。**
「最后 K 线距今 7 个日历日」可能只是 5 个交易日（含周末），也可能因为长假完全不同。
脚本用本次样本的交易日历取前沿日期，按 `--max-lag-sessions`（默认 2）判断落后，
落后的票标 `blocked` 而不是继续给出「便宜」结论。
`--stale-days`（默认 1）只决定是否触发联网刷新。

## 输出

`reports/research/全A行业龙头超跌筛选_<日期>.md` 与同名 `.json`。
JSON 中每只票保留 `weak` / `valuation` / `earnings` / `bounce` / `quotes` 原始读数，
便于复核和二次分析；报告正文按「差哪一关」分组，方便看原因而不是只看结论。

## 局限

- 「龙头」= 行业总市值前 N，不是市场份额或技术领先的证明。
- 东财行业是二级行业名（如「半导体」「白酒Ⅱ」），只决定分组，跨行业估值不可直接比。
- 周期股（煤炭、有色、化工、航运等）的 PE 分位受盈利周期扭曲，必须按中枢利润复核。
- 银行/保险/证券用 PB 主口径；房地产 PE 参考意义弱。
- 新股或次新股 K 线不足 260 根时无法判定，会标 `blocked`。
