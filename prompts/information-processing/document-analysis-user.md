请只输出严格 JSON，不要 Markdown 或代码围栏。只输出下面的最小结构：

{"records":[{"entity":"具体对象名称","informationType":"fact|guidance|forecast|opinion|event|relationship","category":"受控类别 ID","period":"期间（可选）","statement":"包含 entity 名称的一句自足陈述"}]}

字段规则：entity 必须是事实、计划或行为实际涉及的一个具体对象名称；不能填写“营收”“半导体”“业绩表现”等主题词、行业标签或类别名。statement 不超过 120 字，不要以“来源称”“报道指出”“文章提到”开头，也不要使用无法脱离上下文理解的“其”“该公司”。informationType 回答“来源把它说成什么”：fact 是已发生事实或数据，guidance 是管理层/官方目标或计划，forecast 是第三方预测，opinion 是观点，event 是已经发生、计划发生或可能发生的事件，relationship 是供应、客户、竞争或控制等关系。category 必须从下方目录逐字选择，不得创造同义词。period 只在目录要求或允许时填写，且只能是一段时间表达；优先使用 2026Q1、2026H1、2026FY、截至2026-06-30、近3个月、未来3个月等简短写法，不要输出日期对象。目录要求 period 时，原文没有明确期间就不要提取该条。没有可提取内容时输出 {"records":[]}。

受控目录（category: 可用 informationType；period 策略）：
{{CATEGORY_CATALOG}}

标题：{{TITLE}}
来源类型：{{SOURCE_TYPE}}/{{REPORT_TYPE}}
发布时间：{{PUBLISHED_AT}}
正文：
{{CONTENT}}
