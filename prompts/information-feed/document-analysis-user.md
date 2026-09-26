仅返回严格 JSON，不要 Markdown、代码围栏或说明文字。返回以下结构；两个数组都必须出现，合计最多 3 条彼此独立的信息：

{"records":[{"entity":"具体对象名称","informationType":"fact|guidance|forecast|opinion|event|relationship","category":"受控类别 ID","period":"期间（可选）","statement":"包含 entity 名称的一句自足陈述","forecastMeasurement":null}],"categoryCandidates":[{"entity":"具体对象名称","informationType":"fact|guidance|forecast|opinion|event|relationship","statement":"包含 entity 名称的一句自足陈述","suggestedCategory":"简短、具体的中文候选类别名","evidence":"从正文原样复制的连续片段","whyNotExisting":"与最接近的现有类别的具体区别"}]}

先判断正文报道的主信息是否值得提取。常规盘中涨跌、成交额、资金流、技术面描述、标题党复述、重复背景和泛泛解读不进入任何数组。文章为了说明股价或行情而回顾的上市、融资、业绩、合作等背景不能单独提取。不要判断信息是否新增、重复、修正或已经被其他来源证实。对年度、半年度或季度等定期披露，优先保留原文直接披露、带明确期间且能归入指定细粒度类别的指标；若泛化财务摘要与专属经营或监管指标同时存在，优先后者。不要为凑数拆分同一事件。

records 只使用下方目录中的 category ID，不得创造同义词或硬套近似类别。entity 必须是事实、计划或行为实际涉及的一个稳定具体对象名称；不能填写“营收”“半导体”“业绩表现”等主题词、行业标签或类别名。公司融资、上市、评级、经营等事项默认填写公司或发行人的简洁稳定名称，不要拼接“股份有限公司”、H股、股票代码、全球发售或其他交易限定语；关系信息只填一个主要实体，另一方写在 statement。只有原文未给出可识别公司或组织时，才可填写明确命名的项目、产品、市场或联盟。statement 不超过 120 字，不要以“来源称”“报道指出”“文章提到”开头，也不要使用无法脱离上下文理解的“其”“该公司”。informationType 表示资料如何描述该信息：fact 是已发生事实或数据，guidance 是管理层/官方目标或计划，forecast 是第三方预测，opinion 是观点，event 是已经发生、计划发生或可能发生的事件，relationship 是供应、客户、竞争或控制等关系。period 只在目录要求或允许时填写，且只能是一段时间表达；优先使用 2026Q1、2026H1、2026FY、截至2026-06-30、近3个月、未来3个月等简短写法，不要输出日期对象。目录要求 period 时，原文没有明确期间就不要提取该条。尤其 category=listing 只在本文主要报道上市、招股、挂牌或上市进程本身时才可保留；“上市首日破发导致股价回调”一类行情解读不应提取上市事实。

forecastMeasurement 规则：仅当 informationType="forecast"、category 为 revenue|revenue_growth|net_profit|net_profit_growth|gross_margin|eps|operating_cash_flow，且原文明确给出单一预测数值、财年、原始单位及全部口径时，才输出对象；其他所有 record 都输出 null。period 必须精确为该财年的 YYYYFY 或 YYYYQ1/YYYYQ2/YYYYQ3/YYYYQ4，且 fiscalYear 必须与其年份相同。对象只能使用以下字段和值：

{"fiscalYear":2027,"rawValue":0,"rawUnit":"currency|ten_thousand_currency|million_currency|hundred_million_currency|billion_currency|percent|currency_per_share","currency":"CNY|null","accountingBasis":"gaap|non_gaap|adjusted|unspecified","ownershipBasis":"attributable_to_parent|consolidated|common_shareholders|unspecified","shareBasis":"basic|diluted|unspecified"}

rawValue 必须是来源直接写出的有限数值，rawUnit 必须保留来源的原始缩放单位；currency 仅在原文明确时填写，否则为 null。不得从标题、发布日期、机构名称、区间上下限、同比增速、文本推断或外部知识猜测任一字段。只要财年、数值、原始单位、会计口径、归属口径或每股口径任一项不明确，forecastMeasurement 必须为 null；不要因此丢弃其他仍合格的 record。

如果一条明确的主信息符合上述资讯提取范围，却无法准确归入任何现有 category，才在 categoryCandidates 中提出待审候选；已能归入目录的信息只放 records，不得重复。候选名称不是正式类别 ID，不得使用“其他”“综合信息”“一般事件”等兜底名称。候选的 entity、informationType 和 statement 遵循上述相同规则。evidence 长度为 10–160 字，必须从本次正文逐字复制连续片段，不得拼接标题、摘要、外部知识或不同段落。whyNotExisting 应指出与最接近的现有类别的具体边界，而不是笼统说“目录没有”。候选只描述来源表述，不推断投资影响或验证真实性。确实没有合格信息时返回 {"records":[],"categoryCandidates":[]}。

类别目录（category: 可用 informationType；period 策略）：
{{CATEGORY_CATALOG}}

标题：{{TITLE}}
来源类型：{{SOURCE_TYPE}}/{{REPORT_TYPE}}
发布时间：{{PUBLISHED_AT}}
正文：
{{CONTENT}}
