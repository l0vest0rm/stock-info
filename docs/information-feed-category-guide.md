# 资讯提取类别释义（阅读用）

这份说明供人理解现有类别，不参与模型提示词、解析、标签或发布判断，也不新增类别。实际可用的类别 ID、允许的 `informationType` 和 `period` 规则以 [`config/knowledge-ontology.json`](../config/knowledge-ontology.json) 为准；该文件每个类别内的 `label` 是供人阅读的中文翻译，不参与提取契约。页面仍使用 [`web/src/config/information-processing-labels.json`](../web/src/config/information-processing-labels.json) 中的显示名称。修改本说明或 `label` **不会触发重新提取**。

`category` 说明“信息涉及什么事项或指标”；`informationType` 另说明来源把它表述为事实、计划、预测、观点、事件还是关系。后者的 `event` **不是**兜底类别。下列解释是便于阅读的通常含义，不替代原文证据及当前提取规则。

## 财务、经营与市场指标

| 类别 ID | 显示名称 | 便于理解的含义 |
| --- | --- | --- |
| `revenue` | 营收 | 某期间的营业收入金额。 |
| `revenue_growth` | 营收增速 | 某期间营业收入的同比、环比等增长率。 |
| `net_profit` | 净利润 | 某期间的净利润金额；需留意原文是否说明归母等口径。 |
| `net_profit_growth` | 净利润增速 | 某期间净利润的增长率。 |
| `gross_margin` | 毛利率 | 某期间收入扣除相应成本后的毛利率。 |
| `eps` | 每股收益 | 某期间按原文口径计算的每股收益。 |
| `operating_cash_flow` | 经营现金流 | 某期间经营活动产生的现金流量。 |
| `shipment_volume` | 出货量 | 产品或服务在明确期间的出货数量。 |
| `production_capacity` | 产能 | 现有或计划形成的生产能力；区别于实际产量。 |
| `capacity_utilization` | 产能利用率 | 某期间实际使用的产能占可用产能的比例。 |
| `market_share` | 市场份额 | 某主体在明确市场中的销售量或销售额占比。 |
| `order_backlog` | 在手订单 | 已获得、尚待履行的订单规模或数量。 |
| `price_change` | 价格变化 | 商品、产品或服务的价格及其调整；常规证券盘中涨跌不按此类提取。 |
| `target_price` | 目标价 | 分析机构对证券提出的目标价格，不是实际成交价。 |
| `analyst_rating` | 分析师评级 | 分析机构给出的买入、持有、卖出等评级或调整。 |

## 产品、项目、合作与投入

| 类别 ID | 显示名称 | 便于理解的含义 |
| --- | --- | --- |
| `contract_award` | 合同中标 | 获得合同、订单或项目中标的结果；区别于尚未落地的合作意向。 |
| `product_launch` | 产品发布 | 新产品或服务正式发布、推出或上市。 |
| `product_development` | 产品研发 | 具体产品或技术的研发、测试与开发进展；不自动涵盖所有使用中事故。 |
| `strategic_cooperation` | 战略合作 | 主体之间就明确业务方向达成的战略性合作。 |
| `customer_relationship` | 客户关系 | 已明确的客户、供应或采购关系。 |
| `project_signing` | 项目签约 | 明确项目的签署或落地，重点是项目协议本身。 |
| `capacity_expansion` | 产能扩张 | 新建、扩建产线或提升产能的行动；区别于产能数值。 |
| `r_and_d_spending` | 研发支出 | 某期间投入研发的费用或支出金额。 |
| `capital_expenditure` | 资本开支 | 用于厂房、设备等长期资产的资本性支出或计划。 |

## 融资、股权与公司治理

| 类别 ID | 显示名称 | 便于理解的含义 |
| --- | --- | --- |
| `share_repurchase` | 股份回购 | 公司购回自身股份的计划、实施或结果。 |
| `dividend` | 分红 | 公司向股东派息、分配利润的安排或结果。 |
| `financing` | 融资 | 主体通过债务、股权等方式筹措资金的事项。 |
| `listing` | 上市 | 招股、挂牌、上市进程或结果；行情稿回顾上市仅作背景时不提取。 |
| `shareholding_change` | 持股变动 | 股东或相关主体的增持、减持及持股比例变化。 |
| `investment` | 投资 | 对公司、资产或项目的投资决定、实施或关系。 |
| `acquisition` | 收购 | 取得企业、业务或资产权益的收购事项。 |
| `asset_disposal` | 资产处置 | 出售、转让或剥离已有资产或业务。 |
| `debt_repayment` | 债务偿还 | 偿还、提前清偿债务等事项。 |
| `share_issuance` | 股份发行 | 增发、配股等发行股份的行为；区别于公司首次上市本身。 |
| `stock_based_compensation` | 股权激励 | 股票、期权等股权形式的员工或管理层激励安排。 |
| `capital_allocation_outcome` | 资本配置结果 | 已披露的回购、投资等资本配置行为的后续实施结果。 |
| `executive_change` | 高管变动 | 董事或高级管理人员的任免、离职等变化。 |
| `control_rights` | 控制权 | 实际控制人、表决权或控制关系的变化。 |
| `executive_compensation` | 高管薪酬 | 董事或高级管理人员的报酬安排或金额。 |
| `related_party_transaction` | 关联交易 | 与关联方之间的交易安排或执行。 |

## 监管、政策与争议

| 类别 ID | 显示名称 | 便于理解的含义 |
| --- | --- | --- |
| `regulatory_approval` | 监管批准 | 监管机关对申请、产品、交易等作出批准或许可。 |
| `regulatory_investigation` | 监管调查 | 监管机关启动、推进或结束调查。 |
| `audit_opinion` | 审计意见 | 审计机构对财务报告发表的审计意见及其变化。 |
| `regulatory_penalty` | 监管处罚 | 监管机关作出的罚款、警告等处罚。 |
| `litigation` | 诉讼 | 起诉、裁判、和解等司法争议进展。 |
| `policy_change` | 政策变化 | 法律、规章或公共政策的制定、调整和实施。 |

## 银行业专用指标

| 类别 ID | 显示名称 | 便于理解的含义 |
| --- | --- | --- |
| `net_interest_margin` | 净息差 | 银行利息收入与利息支出的差额相对生息资产的收益率。 |
| `loan_growth_rate` | 贷款增速 | 某期间贷款规模的增长率。 |
| `deposit_growth_rate` | 存款增速 | 某期间存款规模的增长率。 |
| `deposit_cost_rate` | 存款成本率 | 银行吸收存款所付利息相对存款规模的成本率。 |
| `non_performing_loan_ratio` | 不良贷款率 | 不良贷款占贷款总额的比例。 |
| `special_mention_loan_ratio` | 关注类贷款占比 | 关注类贷款占贷款总额的比例。 |
| `loan_loss_reserve_coverage_ratio` | 拨备覆盖率 | 贷款损失准备相对不良贷款的覆盖比例。 |
| `credit_cost_ratio` | 信用成本率 | 信用减值损失等相对贷款规模的成本率，具体口径以原文为准。 |
| `capital_adequacy_ratio` | 资本充足率 | 银行监管资本相对风险加权资产的比例。 |
| `common_equity_tier1_capital_ratio` | 核心一级资本充足率 | 核心一级资本相对风险加权资产的比例。 |

**当前覆盖边界：**目录没有“任意突发事件”“事故”或“任务失败”的通用类别。报道可能有明确事实，但若主事件不能准确归入以上类别，现有提取契约允许返回空记录；这不等于新闻没有价值。
