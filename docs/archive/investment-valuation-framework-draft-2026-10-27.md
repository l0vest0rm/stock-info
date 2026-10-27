# 98家观察池：估值方法框架（草案，未落库）

> 状态：`draft`。本文只定义“按商业模式选估值方法”的方法论，不含任何当日价格、目标价或买卖指令。
> 与 `docs/investment-daily-review-playbook.md` 第5步（评价价值）配套使用。
> 不修改 `config/investment-universe.json`、不新增表、不写 `config/investment-daily-report.json`。

## 0. 缺口（必须先补，才能谈个股买卖）

| 缺口 | 影响 | 补法 |
|---|---|---|
| 通用财务估值字段`公司市值/净利润(TTM)/母公司权益/营收(TTM)/经营现金流(TTM)`只覆盖收入表与资产负债表的通用口径 | 银行/保险/券商/资源/REIT 用通用 PE、PB 会系统性失真 | 另建“行业口径”字段：拨备前利润、新业务价值（NBV）、内含价值（EV）、AFFO、EBITDA、周期中枢利润 |
| 缺 `EBITDA`、`净负债`、`少数股东权益`、`永续债` | 无法算 EV/EBITDA、EV/EBIT、EV/FCF | 从资产负债表明细派生，不猜 |
| A/H/ADR/存托凭证的可比性未核验（19家公司多地上市） | 直接用ADR推导A/H估值会出错 | 每地证券单独取价、币种、汇率、存托比例 |
| `watchStatus=research`、`researchPriority=L1`、`themeTags`/`factorExposures` 全为空 | 无法做因子穿透 | 先补 `factorExposures` 再算组合风险 |

## 1. 方法选择表（按赛道）

| 赛道 | 主方法 | 辅方法 | 主方法失效条件 |
|---|---|---|---|
| IT-01 芯片/ASIC | 反推DCF（隐含增速/利润率）+ NTM PE（经调整） | PS、EV/Sales、订单/产能 | 无稳定正FCF、客户集中度未披露 |
| IT-02 代工 | EV/EBITDA（周期中枢）+ PB | PE（鼎盛期失真） | 折旧占比极高时PE会误导 |
| IT-03 设备 | NTM PE + 订单/营收转化率 | EV/Sales、PS | 订单可见度低 |
| IT-04 存储 | 周期中枢利润PE + PB带宽 | EV/Sales、单位位元成本 | 品类不同（DRAM/NAND/HBM/NOR）不可混比 |
| IT-05 光模块/光纤 | NTM PE + 客户结构验证 | EV/Sales、毛利率 | 模块与光纤利润池不同 |
| IT-06 PCB/CCL | NTM PE + ROIC | EV/EBITDA | 认证周期与良率未披露 |
| IT-07/08/09 软件 | EV/ARR、EV/Sales、FCF收益率 | Rule of 40、净留存 | ARR与递延收入口径不一致 |
| COM-01 平台 | NTM PE + FCF收益率 + 分部SOTP | EV/EBITDA | 广告口径与云资本开支混算 |
| COM-02 运营商 | DDM / FCF收益率 + EV/EBITDA | PB | 资费与资本开支政策突变 |
| CD-01 整车 | EV/Sales + 单车毛利 + 反推DCF | NTM PE | 价格战期间PE无意义 |
| CD-02 家电 | PE + 股息率 + ROIC | PB-ROE | 地产链下行 |
| CD-03 电商/平台 | EV/NTM EBIT、EV/EBITDA（分部）、SOTP | PE（剔除投资收益） | 补贴导致EBIT失真 |
| CS-01 高端白酒 | PE + 自由现金流收益率 + 渠道库存 | DCF（低增长） | 批价与动销背离 |
| CS-02 食品饮料 | PE + 股息率 + 提价能力 | EV/Sales | 原料成本冲击 |
| HC-01 创新药 | rNPV（管线风险调整）+ 峰值销售倍数 | EV/Sales、EV/研发 | 管线未过关键临床期 |
| HC-02 器械 | NTM PE + 装机/耗材复购 | EV/EBITDA、PS | 集采与招标节奏 |
| HC-03 医疗服务 | EV/EBITDA + 同店增长 | PE（现金回款口径） | 医保/支付方议价 |
| FIN-01 银行 | PB-ROE（ROTE vs 资本成本）+ DDM | PE（辅助） | 不良率与拨备覆盖不可比 |
| FIN-02 保险 | P/EV + 新业务价值倍数（NBV multiple） | PB-ROEV | 利差假设与资本市场波动 |
| FIN-03 交易所 | PE + 成交量敏感度 | PB（资本轻） | 交易费率调整 |
| FIN-04 支付网络 | EV/EBITDA + 交易量增长 | PE（剔除股权激励） | 监管费率上限 |
| IND-01/02/05 工控/电网/工程机械 | NTM PE + 订单/回款质量 | EV/EBITDA | 招投标与回款错配 |
| IND-03/04 电池/逆变器 | EV/EBITDA + 单位成本 | NTM PE、PS | 价格战与产能过剩 |
| IND-06 物流/航运 | EV/EBITDA（周期中枢）+ PB | PE（周期顶部失真） | 运价极端波动 |
| IND-07 数据中心供电/温控 | NTM PE + 订单积压 | EV/Sales | 订单未转真实收入 |
| MAT-01 铜金矿业 | EV/EBITDA（周期中枢）+ P/NAV | PB、储量估值 | 商品价格假设 |
| MAT-02 化工 | EV/EBITDA + ROIC | PB-ROE | 价差周期 |
| EN-01 油气上游 | EV/DACF + P/储量 | FCF收益率 | 油价假设 |
| EN-02 煤炭 | 股息率 + EV/EBITDA（周期中枢） | PE、FCF收益率 | 长协与政策变化 |
| UTIL-01 公用事业 | DDM + EV/EBITDA + P/B-ROE | 自由现金流收益率 | 水文与电价政策 |
| UTIL-02 燃气 | EV/EBITDA + 股息率 | PE（销气量口径） | 经营价差与居民顺价 |
| RE-01 REIT/不动产运营 | P/AFFO、P/FFO、NAV | 股息率、NAV折价 | 入住率与再融资 |

## 2. 统一估值纪律（所有公司）

1. **同一证券、同一日期、同一币种**：A/H/ADR不混算；`valuationAsOf` 必须与价格日期一致。
2. **先算“保守价值区间”再谈动作**：下限=悲观情景（增速/利润率下调），上限=基准情景；不给出单点目标价。
3. **安全边际阈值**：买入候选要求 `当前价 ≤ 保守价值下限 × (1 − 安全边际)`，安全边际按行业波动分级（成长25–35%、周期20–30%、公用/银行15–20%）。
4. **反推DCF优先**：对高估值成长股，先算“当前价隐含的增长/利润率”，再判断能否实现，而不是先给目标价。
5. **周期股用中枢利润**：存储、航运、煤炭、铜、化工必须以完整周期平均利润估值，不用单季年化。
6. **每股口径**：全部使用摊薄股数；A/B/H/ADR分别换算，存托比例未确认的不做跨市场推导。

## 3. 与每日复盘流程的接口

`config/investment-daily-report.json` 的 `assessments[].valuation` 字段（买入/增持必填）建议包含：

```
{
  "securityCode": "600519.SH",
  "priceDate": "2026-XX-XX",
  "currency": "CNY",
  "method": "pe_fcf_yield",
  "periodBasis": "normalized",
  "conservativeValueLow": null,
  "conservativeValueHigh": null,
  "marginOfSafetyPct": null,
  "assumptions": [],
  "sourceRefs": []
}
```

没有当日价格或保守价值区间的，动作降级为 `watch` / `insufficient_data`。

## 4. 下一步（需用户确认后再做）

1. 是否新设“行业估值口径”配置文件（不新增表，只加 JSON/字段）？
2. 是否为全部赛道先建立 `factorExposures` 映射（用于同因子穿透）？
3. 首轮是否只对 `researchPriority=L2/L3` 的公司做完整估值，其余保持 `watch`？
