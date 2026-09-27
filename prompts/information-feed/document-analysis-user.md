仅返回严格 JSON，不要 Markdown、代码围栏或说明文字。返回以下结构；两个数组都必须出现，合计最多 3 条彼此独立的信息：

{"records":[{"entity":"明确主体名称（公司或非公司均可）","informationType":"fact|guidance|forecast|opinion|event|relationship","category":"受控类别 ID","period":"期间（可选）","statement":"包含 entity 名称的一句自足陈述","forecastMeasurement":null}],"categoryCandidates":[{"entity":"明确主体名称","informationType":"fact|guidance|forecast|opinion|event|relationship","statement":"包含 entity 名称的一句自足陈述","suggestedCategory":"简短、具体的中文候选类别名","evidence":"从正文原样复制的连续片段","whyNotExisting":"与最接近的现有类别的具体区别"}]}

主体类型参考（不输出 entityType 字段）：{{ENTITY_TYPES}}。此列表说明主体不限于公司，不是让你输出类型名代替主体。

records 只使用下方目录的 category ID 和对应的 informationType，不创造类别或输出中文标签代替 ID。示例仅说明规则，不得提取正文没有的信息：
- “机构看好海外涨价提升国产光刻胶导入动力”：entity=光刻胶，category=price_change，informationType=opinion；statement 保留机构归属和涨价影响，不杜撰具体公司。
- “国产光刻胶验证周期由1–2年缩短至6–12个月”：entity=光刻胶，category=product_development，informationType=fact；保留周期变化。“验证周期”是研发信息，不是财务 period。
- “美联储某官员认为应保持限制性货币政策”：entity=美联储，category=policy_change，informationType=opinion；保留官员的判断归属，不写成美联储已决定加息。
- 同文出现“这家公司产品已通过客户验证”，却未给公司名：不猜公司、不把该公司事项泛化为行业事实；前述明确主题信息仍可提取。
- “某股下跌，回顾其上市首日破发”：不单独提取 listing；若没有其他合格主信息则返回空数组。
- “某机构认为资本支出给通胀带来压力”：这不是企业资本开支计划、具体商品调价或政策变动，不能归 capital_expenditure、price_change 或 policy_change；重要且有正文证据时放 categoryCandidates，例如 suggestedCategory=通胀驱动因素，whyNotExisting 说明其是一般物价压力判断而非具体价格或政策事项。文章其他部分有合格政策观点时仍放 records，不互相替代。
- “某公司近几个月实际产量提高10倍”：产量不等于产能或出货量，不能借 production_capacity 或 shipment_volume 绕过目录缺口；符合重要性要求时保留为待审产量候选。不能把“近几个月”臆造为“近3个月”。

period：required 必须有来源明确给出的期间，optional 无明确期间就省略或 null，forbidden 必须省略或 null。不从发布日期猜财年。格式只用 YYYYFY、YYYYQ1–YYYYQ4、YYYYH1–YYYYH2、截至YYYY-MM-DD、近/最近/过去/未来N天/周/月/个月/季度/年，或原文明确的 YYYY年上半年/下半年/全年/第N季度/前N个月；N 用数字。required 且期间无法确定时，不提取该条，也不得伪造候选绕过约束。

forecastMeasurement 规则：仅当 informationType="forecast"、category 为 revenue|revenue_growth|net_profit|net_profit_growth|gross_margin|eps|operating_cash_flow，且原文明确给出单一预测数值、财年、原始单位及全部口径时，才输出对象；其他所有 record 都输出 null。period 必须精确为该财年的 YYYYFY 或 YYYYQ1/YYYYQ2/YYYYQ3/YYYYQ4，且 fiscalYear 必须与其年份相同。对象只能使用以下字段和值：

{"fiscalYear":2027,"rawValue":0,"rawUnit":"currency|ten_thousand_currency|million_currency|hundred_million_currency|billion_currency|percent|currency_per_share","currency":"原文明示的三位币种代码，缺失时为 null","accountingBasis":"gaap|non_gaap|adjusted|unspecified","ownershipBasis":"attributable_to_parent|consolidated|common_shareholders|unspecified","shareBasis":"basic|diluted|unspecified"}

rawValue 必须是来源直接写出的有限数值，rawUnit 必须保留来源的原始缩放单位；currency 仅在原文明确时填写，否则为 null。不得从标题、发布日期、机构名称、区间上下限、同比增速、文本推断或外部知识猜测任一字段。只要财年、数值、原始单位、会计口径、归属口径或每股口径任一项不明确，forecastMeasurement 必须为 null；不要因此丢弃其他仍合格的 record。

如果一条明确的主信息符合上述资讯提取范围，却无法准确归入任何现有 category，才在 categoryCandidates 中提出待审候选；已能归入目录的信息只放 records，不得重复。候选名称不是正式类别 ID，不得使用“其他”“综合信息”“一般事件”等兜底名称。候选的 entity、informationType 和 statement 遵循上述相同规则。evidence 长度为 10–160 字，必须从本次正文逐字复制连续片段，不得拼接标题、摘要、外部知识或不同段落。whyNotExisting 应指出与最接近的现有类别的具体边界，而不是笼统说“目录没有”。候选只描述来源表述，不推断投资影响或验证真实性。确实没有合格信息时返回 {"records":[],"categoryCandidates":[]}。

类别目录（category: 可用 informationType；period 策略）：
{{CATEGORY_CATALOG}}

标题：{{TITLE}}
来源类型：{{SOURCE_TYPE}}/{{REPORT_TYPE}}
发布时间：{{PUBLISHED_AT}}
正文：
{{CONTENT}}
