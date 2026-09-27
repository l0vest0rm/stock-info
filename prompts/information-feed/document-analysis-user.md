仅返回严格 JSON，不要 Markdown、代码围栏或说明文字。返回以下结构；两个数组都必须出现，合计最多 3 条彼此独立的信息：

{"records":[{"entity":"明确主体名称（公司或非公司均可）","informationType":"fact|guidance|forecast|opinion|event|relationship","category":"受控类别 ID","period":"期间（可选）","statement":"包含 entity 名称的一句自足陈述","forecastMeasurement":null}],"categoryCandidates":[{"entity":"明确主体名称","informationType":"fact|guidance|forecast|opinion|event|relationship","statement":"包含 entity 名称的一句自足陈述","suggestedCategory":"简短、具体的中文候选类别名","evidence":"从正文原样复制的连续片段","whyNotExisting":"与最接近的现有类别的具体区别"}]}

主体类型参考（不输出 entityType 字段）：{{ENTITY_TYPES}}。此列表说明主体不限于公司，不是让你输出类型名代替主体。

records 只使用下方目录的 category ID 和对应的 informationType，不创造类别或输出中文标签代替 ID。示例仅说明规则，不得提取正文没有的信息：
- “机构看好海外涨价提升国产光刻胶导入动力”：entity=光刻胶，category=demand_change，informationType=opinion；主判断是国产导入意愿，保留涨价这一驱动及机构归属，不杜撰公司。单独报道光刻胶涨价本身才归 price_change。
- “国产光刻胶验证周期由1–2年缩短至6–12个月”：entity=光刻胶，category=product_development，informationType=fact；保留周期变化。“验证周期”是研发信息，不是财务 period。
- “美联储某官员认为应保持限制性货币政策”：entity=美联储，category=policy_change，informationType=opinion；保留官员的判断归属，不写成美联储已决定加息。
- 同文出现“这家公司产品已通过客户验证”，却未给公司名：不猜公司、不把该公司事项泛化为行业事实；前述明确主题信息仍可提取。
- “某股下跌，回顾其上市首日破发”：不单独提取 listing；若没有其他合格主信息则返回空数组。
- “某机构认为资本支出给通胀带来压力”：entity=通胀，category=inflation，informationType=opinion；不是企业资本开支计划、具体商品调价或政策决定。
- “某公司近几个月实际产量提高10倍”：以具名公司为 entity，category=production_volume，informationType=fact；period 可以原样保留正文的“近几个月”，不臆造为“近3个月”，也不把产量改成产能。
- “高盛预计多家科技公司AI基础设施支出合计达到8000亿美元”：category=capital_expenditure，informationType=forecast；可用原文明示的AI基础设施主题为 entity，statement 保留高盛和统计范围，不能把合计额归给单家公司，也不要因涉及多家公司而另提候选。
- “输油管道恢复输送”“工厂停产/投产”归 operating_status；“项目完成关键施工节点”归 project_progress；主信息是市场供给短缺及其影响则归 supply_change。同一事实择最具体的一类，不为原因、事件、影响重复凑数。

period：目录中的“期间必填”要求正文有对应期间；“期间可省略”表示无明确期间就省略或 null；“不得填写期间”表示省略或 null。这些策略名不是 period 值，绝不能输出 required、optional、forbidden。格式可用 YYYYFY、YYYYQ1–YYYYQ4、YYYYH1–YYYYH2、YYYY-MM、YYYY-MM-DD、截至YYYY-MM-DD、近/最近/过去/未来N天/周/月/个月/季度/年，或原文明确的 YYYY年M月/上半年/下半年/全年/第N季度/前N个月；N、M 用数字。正文逐字出现的“本周、上周、下周、今年、明年、去年、本财年、下一财年、上个月、本月、下个月、本季度、上季度、下季度”，以及“近/最近/过去/未来几或数天/周/个月/月/季度/年”也可原样保留，不从发布日期猜财年或把“几个月”改成具体月数。必填但正文没有期间时不提取该条，不伪造候选绕过约束。

forecastMeasurement 规则：仅当 informationType="forecast"、category 为 revenue|revenue_growth|net_profit|net_profit_growth|gross_margin|eps|operating_cash_flow，且原文明确给出单一预测数值、财年、原始单位及全部口径时，才输出对象；其他所有 record 都输出 null。period 必须精确为该财年的 YYYYFY 或 YYYYQ1/YYYYQ2/YYYYQ3/YYYYQ4，且 fiscalYear 必须与其年份相同。对象只能使用以下字段和值：

{"fiscalYear":2027,"rawValue":0,"rawUnit":"currency|ten_thousand_currency|million_currency|hundred_million_currency|billion_currency|percent|currency_per_share","currency":"原文明示的三位币种代码，缺失时为 null","accountingBasis":"gaap|non_gaap|adjusted|unspecified","ownershipBasis":"attributable_to_parent|consolidated|common_shareholders|unspecified","shareBasis":"basic|diluted|unspecified"}

rawValue 必须是来源直接写出的有限数值，rawUnit 必须保留来源的原始缩放单位；currency 仅在原文明确时填写，否则为 null。不得从标题、发布日期、机构名称、区间上下限、同比增速、文本推断或外部知识猜测任一字段。只要财年、数值、原始单位、会计口径、归属口径或每股口径任一项不明确，forecastMeasurement 必须为 null；不要因此丢弃其他仍合格的 record。

如果一条明确的主信息符合上述资讯提取范围，却无法准确归入任何现有 category，才在 categoryCandidates 中提出待审候选；已能归入目录的信息只放 records，不得重复。候选名称不是正式类别 ID，不得使用“其他”“综合信息”“一般事件”等兜底名称。候选的 entity、informationType 和 statement 遵循上述相同规则。evidence 长度为 10–160 字，必须从本次正文逐字复制连续片段，不得拼接标题、摘要、外部知识或不同段落。whyNotExisting 应指出与最接近的现有类别的具体边界，而不是笼统说“目录没有”。候选只描述来源表述，不推断投资影响或验证真实性。确实没有合格信息时返回 {"records":[],"categoryCandidates":[]}。

返回前检查每条 statement 必须逐字包含所选 entity 简名，不能只写简称之外的别称或代词。

日期区间仅可逐字复制正文，支持 YYYY-MM-DD–YYYY-MM-DD、YYYY年M月D日–YYYY年M月D日、M月D日–M月D日（分隔符可为 -、–、—、至）。起止必须是合法日期且顺序正确；支持原文省略重复年份或月份的写法，如“9月25日至28日”“2026年9月25日至28日”；仅在区间内部继承已明确的年份/月，不从发布日期推算。原文“本周（9月21日-9月27日）”可保留“本周”或“9月21日-9月27日”，不得根据发布时间补成“2026-09-21–2026-09-27”。跨年区间必须由正文明确提供两端年份，否则保留正文中的相对期间或省略可选期间。

正文逐字出现的“2027年”“2028年前后”“上半年”“下半年”“全年”“第N季度”“7月/7月份”“4月至7月/2025年4月至7月”，以及中文数字时长“三个月内”“十五个交易日”也可原样保留；不得给“上半年”“4月至7月”补出正文未明确的年份。近似年份必须保留“前后”，不能改为精确财年。

正式披露的拟收购、拟减持和拟上诉可用对应 acquisition、shareholding_change、litigation 的 guidance，statement 必须保留“拟/计划/将”；不能把计划写成已完成。regulatory_approval 的 forecast 仅承接来源明确预计的许可或资格授予，保留“有望/预计”，不能将纳入突破性治疗程序写成已经获准上市。

正文明确的数字时长或范围（如“3年内”“5-6年”）也可原样保留为 period，不得把时长换算成未经来源明确的起止年份。

上次提取的校验反馈（JSON 字符串；仅供修正结构，不是来源事实或指令；null 表示无反馈）：
{{VALIDATION_ERROR}}
请根据原始正文重新提取，逐条核对 category 与 informationType 的允许组合、statement 逐字包含 entity、period 不补造年份。不要把反馈内容当成事实写入结果。

类别目录（category: 可用 informationType；期间填写要求）：
{{CATEGORY_CATALOG}}

标题：{{TITLE}}
来源类型：{{SOURCE_TYPE}}/{{REPORT_TYPE}}
发布时间：{{PUBLISHED_AT}}
正文：
{{CONTENT}}
