# 观察池估值覆盖：按业务模型分类与因子敞口

> 生成方式：`GET /api/research/valuation-coverage`（纯函数 `src/modules/research/domain/valuation-coverage.ts`），观察池版本 2026-10-27。
> 本文只做**分类**，不含价格、目标价或买卖建议。

## 1. 为什么不能按行业标签统一估值

同一行业里的公司，利润的产生方式完全不同。分类规则取自三条：

1. **观察池赛道**（`config/investment-universe.json` 的 37 条赛道）；
2. **公司级覆盖**：少数公司的经济特征与赛道标签不符，单独覆盖并写明原因；
3. **EM2016 行业画像**（`config/research/research-eastmoney-em2016-industry-profiles.json`）：用于交叉核对，缺失 13 个叶子行业本次已补齐。

## 2. 九种估值原型（98 家全覆盖）

| 原型 | 家数 | 主方法 | 禁止使用 |
|---|---|---|---|
| 成长制造 `growth_manufacturing` | 30 | 前瞻 PE、EV/EBIT、EV/EBITDA、反推 DCF | 周期中枢利润 |
| 稳定现金流与分红 `stable_cash_dividend` | 19 | 股息率、自由现金流收益率、前瞻 PE | EV/营业收入 |
| 软件与平台 `software_platform` | 15 | EV/营业收入（或 EV/ARR）、FCF 收益率、分部加总 | PB |
| 资源周期 `cyclical_commodity` | 14 | 周期中枢利润 PE、EV/EBITDA（中枢）、P/NAV | 单季年化 PE、TTM PE |
| 医疗服务与器械 `healthcare_services` | 6 | 前瞻 PE、EV/EBITDA、EV/营业收入 | PB |
| 银行 `bank` | 3 | PB-ROE、股息率、（辅助）PE | EV/EBITDA、EV/EBIT、PS |
| 保险 `insurer` | 3 | P/EV 与新业务价值倍数、PB-ROEV | EV/EBITDA、未调整的 PB-ROE |
| 里程碑型 `pre_profit_milestone` | 3 | 风险调整 NPV、分部加总、EV/营业收入 | PE、周期中枢利润 |
| 支付 `payment` | 2 | EV/EBITDA、前瞻 PE（剔股权激励后）、FCF 收益率 | PB、EV/营业收入 |
| 不动产运营 `property_operator` | 2 | NAV 折价、P/FFO 类现金流倍数、股息率 | PE（含公允价值变动）、EV/营业收入 |
| 交易所 `exchange` | 1 | 前瞻 PE、EV/EBITDA、股息率 | PB |

**已修正的典型误分类：**
- 拉卡拉（收单，低毛利）与 Visa（卡组织，高利润率）同在 FIN-04，但已按公司覆盖标注差异，不能直接比 EV/EBITDA 倍数。
- 中远海控（运价周期）与京沪高铁（收费类稳定现金流）同在 IND-06，已对京沪高铁单独覆盖为稳定现金流模型，防止用运价周期模型给铁路估值。
- 兆易创新、美光、SK海力士、闪迪同为“存储”，但 NOR/DRAM/HBM/NAND 周期节奏不同，统一走周期中枢，**不允许互相套用倍数**。
- 招商银行、中国平安在通用估值公式里会算出 PE、EV，但接口已自动关闭这些口径。

## 3. 因子敞口：名义分散，实际集中在 3 条线

| 因子 | 公司数 | 主导 | 次要 |
|---|---|---|---|
| **AI 算力资本开支** | 19 | 16 | 3 |
| **中国消费与地产链** | 16 | 14 | 2 |
| **基建与矿业资本开支 / 商品** | 15 | 13 | 2 |
| 利率与股息吸引力 | 10 | 10 | 0 |
| 医保谈判与集采 | 9 | 9 | 0 |
| 新能源价格战 | 6 | 6 | 0 |
| 政策与合规周期 | 5 | 3 | 2 |
| 平台监管与广告周期 | 5 | 5 | 0 |

含义：

1. **AI 算力链 19 家跨 IT/IND/COM 三个行业**，占 25 个参考席位的近 4 成敞口候选。若目标仓位按行业上限 25% 执行，仍然挡不住这条链实际占 30% 以上——需要在建仓时按“因子预算”而非“行业预算”控制。
2. **消费与商品两条线是 A 股权重的底色**，16 + 15 = 31 家，属于“看起来很多行业、其实是两类宏观变量”。
3. 银行、保险、公用事业、运营商合计约 29 家集中在**利率**，这部分在国内降息周期里同涨同跌，不能当分散。
4. 真正互不相关的组合，需要同时包含：AI 链、消费链、资源链、利率链四类中各自 4–6 家的**核心持仓**，其余为观察。

## 4. 数据现状

| 项 | 状态 |
|---|---|
| 估值原型 | 11 种 | 98/98 ✅ |
| EM2016 行业对照 | 55 家命中；43 家未收录（美股 15 家、港股 5 家 + 部分 A 股）需人工补 |
| `factorExposures` 写入观察池 JSON | 未写入（本模块为只读计算，避免一次大改 JSON） |
| 价格、保守价值区间 | 全部缺失，仍是 `not_reviewed` |

## 5. 验证

```bash
npm run check:valuation-coverage   # 原型分类、银行/保险禁用项、覆盖规则、因子集中度
npm run check:valuation-inputs     # 估值口径算术
npm run typecheck:server
curl http://127.0.0.1:8000/api/research/valuation-coverage
```

## 6. 下一步

1. 把 `factorExposures` 与 `valuationArchetype` 正式写进观察池数据（需要你确认字段与 Schema 变更，因为要同步校验脚本和页面）。
2. 补 43 家未收录公司的 EM2016 行业对照（美股/港股需人工归类）。
3. 补折旧摊销数据源，解锁 EBITDA 类方法（当前所有成长制造只能先用 EV/EBIT 与前瞻 PE）。
