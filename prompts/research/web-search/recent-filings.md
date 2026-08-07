研究对象：{{SECURITY_CODE}}（{{SECURITY_NAME}}，{{MARKET}}，交易币种 {{CURRENCY}}）

这是“经营变化包”。目标是找出相对既有财报基线真正新增或发生变化的信息：经营趋势、产品进展、客户/订单、产能、管理层指引、重大合同、融资、回购、审批、催化剂和风险。重点搜索财报边界之后及最近十二个月的信息，但不要把来源形式限定为公告。

已确认的法定财报边界：{{FINANCIAL_DISCLOSURE_BOUNDARY}}
已知字段：截至 {{LATEST_FINANCIAL_REPORT_PERIOD}}；发布日期 {{LATEST_FINANCIAL_REPORT_PUBLISHED_AT}}；标题《{{LATEST_FINANCIAL_REPORT_TITLE}}》；原文 {{LATEST_FINANCIAL_REPORT_URL}}。
每条记录必须能说明“相对该边界的新变化”、发生或披露日期，以及它是已发生事实、管理层指引还是待触发事件。公司结构化三表数值不是本包主值。优先使用公司、交易所和监管材料；当一手材料没有解释变化原因或行业影响时，可以补充公开研报、行业机构资料和权威媒体，但必须明确判断主体，不能把第三方解释写成公司事实。

同一资料一次提取多个字段。evidence_records[].tab_id 仅可为：{{TAB_IDS}}。字段名和枚举值使用英文 snake_case；不得输出中文 Tab 名称。除字段名、枚举值、证券代码、单位和来源原标题外，所有输出内容使用简体中文。
