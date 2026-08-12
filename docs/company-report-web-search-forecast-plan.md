# 公司研报 Web Search 预测整合方案

> 说明：本文第 2.2 节所述的“Web Search 证据包”已删除，不能作为当前实现或后续方案依据。

状态：设计稿（proposed）。本文件只新增设计文档，不改变运行时代码、测试、迁移或既有 API。

阅读约定：文中“当前”是对仓库代码、配置和迁移的静态核对结论，不等于本次已完成真实模型、长连接、浏览器或生产证明；“拟议”/“proposed”是目标设计，不能当作已存在的表、接口或行为。现有统一设计和数据路由分别见 [`investment-analysis-llm-task-unification-plan.md`](./investment-analysis-llm-task-unification-plan.md) 与 [`investment-analysis-data-acquisition-routing.md`](./investment-analysis-data-acquisition-routing.md)。

## 1. 目标与非目标

### 1.1 目标

1. 在当前公司研报候选列表之外，使用 Web Search 发现公司近期公开可访问的新增研报；搜索任务的目标是“找报告”，不是为已列出的报告重新提取预测。
2. 给模型的输入只包含证券/公司身份、近期时间窗口和搜索约束，不传当前页面已经列出的研报、PDF/HTML 正文或已有列表。模型返回每篇候选的报告元数据，以及与普通 PDF 研报解析相同的 `forecasts` 和 `valuation` 字段。
3. 将 Eastmoney、Sina、已有知识研报和搜索发现候选统一转换为同一报告行，在服务端合并、去重、排序、分页；当前报告表只增加一列来源/出处，不建立第二张表或第二套展示。
4. 由工程代码而非模型决定“是否重复”和“是否保留”：先用 URL/原生 ID，再用代码、日期、规范化标题和机构做确定性去重；模型不接收旧列表，也不输出 `dedupe`、`keep` 或“新增”判断。
5. 维持现有年度预测字段的口径和本地/生产 LLM 边界。没有可核验 URL、报告元数据或明确数字时显示缺口，不用模型常识、相邻年份或推导值冒充来源预测。

### 1.2 非目标

- 本设计不立即修改当前 `company.routes.ts`、Web 页面、数据库迁移、prompt 或既有 API 形状；它冻结后续实现所需的输入、输出和合并契约。
- 不用 Web Search 替代 Xueqiu K 线、结构化三表、证券主数据、13F、宏观时间序列或基金净值；这些数据仍遵守 [`AGENTS.md`](../AGENTS.md) 的来源边界。
- 不把 `forecast_consensus` 外部预测补充包或搜索发现的研报行直接写入 `research_source_forecasts`、确定性汇总快照或“市场一致预期”；若未来要纳入内部账本，必须另走现有来源身份和口径门禁。
- 不把搜索摘要、付费报告目录、媒体无原文转述、模型常识或数学反推当作来源事实；没有本次 Web Search 原生 citation 的 URL 不能作为可打开报告链接。
- 不让生产 Cloudflare Worker 调用远端 LLM；不以重试、备用来源、模型去重判断或空值填充掩盖搜索/解析失败。
- 不在本设计中决定新的模型、授权域名、估值公式、K 线来源或删除旧数据的时间表。

## 2. 当前已核实链路

### 2.1 `company-report` 当前链路（静态核对）

涉及实现：`src/modules/company/api/company.routes.ts`、`src/modules/company/application/report-analysis-cache.ts`、`src/generated/prompt-text.ts`、`web/src/modules/company/runtime/company-pages-runtime.ts` 和 `web/src/modules/company/pages/company-report-page.ts`。

1. **候选列表。** `GET /api/company/reports?code&page` 与 `GET /api/company/reports/stream` 进入 `getCompanyReportsWithProgress()`。中国 A 股候选来自 Eastmoney 报告列表、Sina 报告列表和 `knowledge_docs` 中标题/摘要含研报线索的资讯，前两者按主来源合并；`app_kv` 的 `company-reports-source:v4:<code>` 缓存 TTL 为 12 小时，源池最多 100 条，页面每页 10 条。当前链路只在第一页补预测。
2. **候选与调用数。** 资讯研报候选最多 5 条，普通报告补预测与资讯合计最多 10 次。当前每次 `GET` 可能在本地运行时同步触发补充工作；页面第一页使用 SSE 的 `progress`、`partial`、`result` 事件，`partial` 是已读取的报告行重新标注，不是可恢复的 LLM 终态。
3. **报告内容。** Eastmoney `infoCode` 先下载 PDF，最多解析 30 页并以 `eastmoney-report-pdf-text:<infoCode>` 缓存；Sina 读取详情 HTML 并以 `sina-report-detail:<url>` 缓存；知识库资讯优先从公开内容 URL/R2 内容读取，失败时退回 `contentPreview/summary`，截取最多 12,000 字符。
4. **提取顺序。** `extractCompanyReportByLlm()` 先格式化 PDF/HTML 文本，再运行确定性 Markdown 表格/年度句式解析；命中有效年度字段即不调用模型。未命中才调用 `requestLlmText()`，模型为 `gpt-5.6-luna`、`maxTokens=4096`，使用研报抽取 prompt，要求仅提取明确年度预测，营收和净利润换算为亿元，缺字段返回 `null`。资讯使用另一个 prompt，先判断是否确为有明确机构/分析师结论的公司研报，再提取预测与估值字段。
5. **当前缓存。** 单篇报告缓存键为 `report-forecast:v4:<reportId>`，共享 Eastmoney 报告键为 `shared-report-analysis:v6:eastmoney:<infoCode>`，预测缓存 TTL 为 30 天；同一进程的 `sharedReportAnalysisInFlight` 只做并发合并。`app_kv` 中的 `analysisCalled/analysisSucceeded/forecasts` 没有来源摘录、证据 ID、期间/币种/会计口径或版本替代链。
6. **当前解析门禁。** `parseCompanyReportForecasts()` 只接受 JSON 对象中的 `forecasts` 数组；每行必须有正整数年份且至少有 revenue/netProfit/eps/pe 之一，增速等字段可选；解析器不会为每个数值保存原文引用。资讯解析还接受可选 `rating/targetPrice/targetPriceCurrency/targetPe/valuationMethod`。
7. **当前标记、展示与派生。** `annotateReportItemsWithForecasts()` 将普通报告标为 `forecastSource=llm_report_source`，知识资讯研报标为 `llm_news_report`，并把缓存提取与候选原有字段合并。服务端另读 Eastmoney 公司概览和结构化年度利润，为每个预测按当前市值/净利润或当前价/EPS 计算 `computedPe`、缺失净利润时计算 `computedNetProfit`，并标记计算时点。页面把报告映射为固定 2025–2028 列；会以结构化实际覆盖同年预测，必要时回退旧的 `predictThisYear*` 字段，并把 EPS×当前总股本推导值标为“推”。这些是派生显示，不是来源预测事实。
8. **错误和运行边界。** 单篇提取异常当前被 `ensureReportForecastsForItemsWithProgress()` 捕获并 `console.error`，随后继续其他候选；这意味着页面可能只看到缺字段，未必知道失败原因。`extractCompanyReportByLlm()` 和资讯提取明确要求 `LLM_RUNTIME=local`，生产路径不能调用模型；本地运行成功不能证明生产页面具备同样字段。

结论：当前公司研报预测是“候选列表 + `app_kv` TTL 提取缓存 + 页面派生”的链路，尚未成为带原文证据和独立版本的预测业务投影，也没有接入 `research_source_forecasts`。

### 2.2 已删除的 `forecast_consensus` 链路

原 Web Search 证据包及其 `forecast_consensus` 子类型已经删除：不再有配置、prompt、接口、local runner 或 `research_web_search_*` 投影表。第三方预测仍只经知识文档处理和既有来源审核进入 `research_source_forecasts`；不会以通用 Web Search 包补充或宣称“市场一致预期”。

## 3. 推荐架构（拟议）

### 3.1 统一报告行与所有权

`CompanyResearchReportRow` 是统一的逻辑行模型，不是新表。它复用现有报告条目字段：`code`、`title`、`publishDate`、`orgName`、`url`/`infoCode`/`knowledgeDocId`、`attachPages`/`pages`、`forecasts` 和 `valuation`，并增加服务端写入的 `provenance`：`existing`（Eastmoney、Sina 或已有知识来源）或 `web_search`（本次搜索发现）。`provenance` 不接受模型返回，也不与现有表示预测提取来源的 `forecastSource` 混用。

不新增 `company_report_forecast_projection`、`company_report_forecast_value`、`company_report_forecast_evidence` 或第二个研报表。现有 `app_kv` 报告源缓存可以缓存合并后的行；如未来要保存搜索正文，复用 `knowledge_docs`，不为搜索报告另建存储模型。

### 3.2 端到端时序

```text
公司研报页刷新（第一页）
  → 读取 Eastmoney、Sina、knowledge_docs 的现有候选池
  → 只向本地 LLM/Web Search 发送公司身份、近期窗口和搜索约束
  → 模型返回 reports[]（元数据 + forecasts + valuation）
  → 服务端校验 citation、元数据和字段，写入 provenance=web_search
  → 与现有候选池合并，确定性去重
  → 过滤近期范围、按发布日期排序、分页；GET/SSE 返回同一行形状
  → 页面继续使用当前研报表，只增加“来源”一列
```

模型输入不包含当前报告列表、报告正文或 PDF；模型也不判断候选是否重复、是否保留。已有 `forecast_consensus` 包仍是另一种外部预测资料，不作为本流程的报告发现器。

## 4. 搜索输入、响应与字段规则（拟议）

### 4.1 搜索输入和来源约束

最小搜索输入是下面的 Markdown/纯文本 prompt 模板，不是 JSON 请求；实际值由服务端填入：

```markdown
# 公司研报发现任务

## 研究对象

- 证券代码：{{SECURITY_CODE}}
- 公司名称：{{COMPANY_NAME}}
- 搜索起始日期（recent-since）：{{RECENT_SINCE}}
- 最多返回报告数：{{MAX_REPORTS}}

## 任务与约束

请使用 Web Search，发现该公司自“搜索起始日期”以来近期公开可访问的研究报告。

- 只寻找明确属于该公司的真实研报原文或可直接打开的公开报告页面；优先研究机构、公司 IR、交易所/监管或报告原文。
- 本 prompt 不提供当前页面已有报告列表，也不提供已有报告的 PDF/HTML 正文；不得假定或复述这些输入之外的报告内容。
- 媒体转载只能作为线索，必须回到可访问原文并使用本次搜索的原生 citation URL。
- 每篇候选返回标题、研究机构、发布日期、可打开 URL，以及原文明确的年度预测和估值字段。
- 不要判断候选是否重复、是否“新增”、是否保留或删除；不要输出 `dedupe`、`keep`、`isNew`、`reportId`、`provenance` 等工程字段。重复排除由服务端在响应后确定性处理。
```

这里的 Markdown 是模型输入；下节的 `reports[]` JSON 仅是模型输出契约。模型必须搜索近期公开报告，但不接收已有报告列表，因此“是否已经列出”不能由模型判断，统一由服务端响应后去重。

搜索摘要、付费报告目录、无法确认公司/机构/日期的页面和没有本次原生 citation 的 URL 不进入可展示行。结构化行情、三表等已有主数据不通过搜索重采集。

### 4.2 最小模型响应

模型只返回一个 JSON 对象；字段名与当前 PDF/HTML 研报解析契约保持一致：

```json
{
  "reports": [
    {
      "title": "公司研究报告标题",
      "institution": "研究机构名称",
      "publishedAt": "2026-06-20",
      "url": "https://public.example/report.pdf",
      "forecasts": [
        {
          "year": 2026,
          "revenue": null,
          "revenueGrowth": null,
          "netProfit": null,
          "profitGrowth": null,
          "eps": null,
          "pe": null
        }
      ],
      "valuation": {
        "rating": null,
        "targetPrice": null,
        "targetPriceCurrency": null,
        "targetPe": null,
        "valuationMethod": null
      }
    }
  ]
}
```

`title`、`institution`、`publishedAt` 和可打开的 `url` 是报告候选的必需元数据；`forecasts` 和 `valuation` 字段可为空，数字只能来自原文明确的年度预测/估值。营收和净利润沿用当前“亿元”口径，增速为百分数数值，字段缺失返回 `null`，不得用 EPS、目标价或常识反推。服务端将 `institution→orgName`、`publishedAt→publishDate`、`url→url`，搜索行的 `pages` 为空；URL 必须能在本次 Web Search citation 中核验，模型不能自造链接。

## 5. 合并、确定性去重、新鲜度

搜索响应先归一化为 `CompanyResearchReportRow`，再与 Eastmoney、Sina、knowledge_docs 全部候选合并；去重发生在过滤、排序和分页之前，且搜索批次内部也使用同一规则：

1. 规范化 `url`（协议/host 统一大小写、去 fragment 和追踪参数、规范末尾斜杠）相同即同篇；其次比较同一命名空间下的原生 ID，如 `eastmoney:infoCode`、`knowledge:<docId>`。搜索行没有原生 ID 时由规范化 URL 生成内部 ID，不能使用模型提供的 ID。
2. 若没有可用 URL/原生 ID，比较完整键：`(normalized security code, YYYY-MM-DD publishDate, normalizeReportTitleCore(title), normalizeReportOrgName(institution))`。四项全相同才合并。
3. 只有双方发布日期都缺失时，才允许退化为 `(code, titleCore, institutionCore)`；一方有日期、一方无日期时不按退化键合并。绝不按标题单独去重，同名但不同机构或不同日期的报告必须保留。

当前 `titleCore|org` 的弱键不能作为本流程的最终去重规则。报告保留与近期过滤由服务端固定策略（当前 90 天和源缓存 TTL）决定；模型永远不判断重复、保留或删除。搜索失败时保留已有行并显示失败状态，不生成伪造候选；源缓存版本需递增以隔离未包含搜索结果的旧列表。

## 6. API 与前端展示

最小方案复用 `GET /api/company/reports`、`GET /api/company/reports/stream` 和现有分页，不另建“搜索研报”接口或第二张表。两种来源都返回同一行字段，只增加可选 `provenance`；搜索行使用外部 `url`，已有 `infoCode`/`knowledgeDocId` 的打开路径保持不变。

当前固定 2025–2028 预测列、估值列、机构列和页数列全部保留，在表格中增加一列“来源”：`existing` 显示“已有来源”，`web_search` 显示“搜索发现”。SSE 的 `partial` 和 `result` 都携带该字段，分页前后的行形状一致；不把 `forecastSource` 当作这列的值。

状态至少区分：搜索成功但没有新报告、候选被确定性去重、候选元数据/citation 不合格、搜索失败、以及现有来源加载失败。没有年度预测是合法的空 `forecasts`，不等于搜索失败。

## 7. 缓存与运行边界

```text
LLM 请求缓存（仅降低相同搜索请求成本）
          ↓
合并后的 company-reports-source 缓存（包含 provenance）
          ↓
现有 GET/SSE 报告行与同一张表
```

`llm_cache_entries`/`app_kv` 只做请求或源列表加速，不是新的报告事实表，也不能改变去重结果。搜索输入（公司代码、窗口、prompt 版本）变化时使用新缓存键；同一 URL/原生 ID 的已解析行可复用，不重复搜索。`LLM_RUNTIME=local` 的 Node 运行时才可发起远端 LLM/Web Search；生产 Worker 只读已缓存/物化的合并行，不因有凭据而调用模型。

## 8. 错误可见性

以下情况必须在 API/SSE 状态中可见，不能只写控制台：Web Search 未执行或无原生 citation、JSON 不含 `reports`、缺少标题/机构/日期/URL、URL 不可打开、模型返回非年度预测、单位/期间不明确、候选被确定性去重、以及现有 Eastmoney/Sina/知识来源失败。

“没有新报告”是搜索成功后的空结果；“候选无预测”是可展示行中空 `forecasts`；“搜索/解析失败”是错误状态。失败不得用重复行、模型常识或旧列表伪装成功。

## 9. 分阶段实施与验证（拟议）

### 阶段 0：契约冻结

- 固定搜索请求、`reports[]` 响应、`provenance` 枚举和现有预测/估值字段；确认模型输入不含既有报告列表或正文。
- 用真实报告样本覆盖直接 PDF、报告页面、转载线索、缺日期、缺机构、无 citation、同标题不同日期/机构等情况。

### 阶段 1：搜索 adapter 与服务端合并

- 本地 LLM/Web Search 返回并校验 `reports[]`，映射为现有行字段；与 Eastmoney、Sina、knowledge_docs 全池合并。
- 在排序/分页前验证 URL/原生 ID、完整复合键和“双日期缺失”退化键；确认模型不能影响去重和保留。

### 阶段 2：API/UI 兼容接入

- 仅给现有报告行增加 `provenance`，表格增加一列来源；验证 `/api/company/reports` 和 SSE `partial/result` 使用同一行形状。
- 浏览器场景：刷新公司研报页 → 搜索返回新增行 → 检查来源列 → 刷新/换页后不重复；搜索失败时已有行仍可见且状态明确。

### 阶段 3：运行与生产读验证

- 用 `./start-local.sh` 验证本地真实搜索、citation、缓存命中和重启后的合并结果；再单独验证生产 Worker 只读已物化行。
- 记录请求时间、搜索结果 URL、去重计数和最终 API/SSE payload；静态检查、模型返回非空或 HTTP 200 均不能替代完整结果证明。

## 10. 风险与明确不做项

- **转载/重复：** URL、原生 ID 和服务端复合键只能确定“同一报告候选”，不按机构名或模型判断独立性；同名不同日期/机构保留。
- **来源受限：** 付费目录、搜索摘要或无法打开的页面只能记录缺口，不进入可点击展示行。
- **PDF/网页抽取误读：** 只显示原文明确年度预测，单位和期间不清就置 `null`；派生 PE/净利润继续按现有代码单独标记。
- **搜索失败/缓存漂移：** 保留已有来源并显示失败，搜索缓存版本与输入窗口隔离，不以重试或备用来源隐藏错误。
- **本设计明确不做：** 给模型发送已有研报列表或正文、让模型判断重复/保留、建立第二张研报表或 forecast projection 表、把 Web Search 结果改名为市场一致预期、把模型返回文本直接写入内部预测账本、生产 Worker 兜底调用 LLM。
