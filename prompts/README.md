# Prompt 使用映射

本目录只保留当前仍有运行时入口的提示词。判断标准是：必须能从页面/API/CLI 入口追到实际发送点；仅被旧文档、旧生成产物或已删除 runner 提到的不保留。

新增或修改模型可见提示词前，应先确认任务类型和输出契约；研究报告输出原始 Markdown，抽取与分类任务输出严格 JSON。提示词只包含模型任务、已确认资料、允许的检索范围及交付契约，不写运行时实现或存储细节。模型调用须遵守 [本地与生产隔离](../docs/architecture.md#llm-与发布隔离)。

## 调用方式

| 标记 | 实际链路 |
| --- | --- |
| `直接 LLM` | 本地 Node 运行时创建 `generic_raw_model` 任务，由本地 generic runner 通过 OpenAI/llm-proxy 执行；不是 taskd 的 ChatGPT WebQA。生产环境不允许触发。 |
| `taskd ChatGPT` | 页面/API 将任务提交到 taskd，`task_type=webqa.chatgpt.v1`，由 taskd 的 ChatGPT WebQA 执行。 |
| `无自动调用` | 只生成或保存 Prompt，当前代码不会自动提交模型任务。 |

## 当前保留的 Prompt

| Prompt 文件 | 页面/功能 | 调用入口 | 调用方式 |
| --- | --- | --- | --- |
| `company/report-analyze-system.md` + `company/report-analyze-user.md` | 公司研报页：读取研报正文后补充年度业绩预测和单一目标价；知识库新闻命中估值/评级关键词后也复用这套提取模板 | `src/modules/company/application/analyze-company-report.ts` 的 `extractCompanyReportAnalysisByLlm()`；`extractCompanyNewsReportByLlm()` 在代码侧关键词粗筛通过后复用该模板 | 直接 LLM |
| `company/report-discovery.md` | 公司研报页“搜索近期公开研报” | `src/modules/company/application/company-reports.ts` 的 `enqueueCompanyReportDiscovery()`；前端入口为 `web/src/modules/company/pages/company-report-page.ts` | taskd ChatGPT |
| `knowledge/topic-batch-system.md` + `knowledge/topic-batch-user.md` | 知识库导入：标题级 AI 产业链主题筛选，只有不确定批次才调用 | `scripts/process-knowledge-once.mjs` 的 `reviewTopicBatchWithLlm()` | 直接 LLM |
| `information-feed/document-analysis-system.md` + `information-feed/document-analysis-user.md` | 资讯流正文提取正式记录与待审类别候选 | `scripts/information-feed.mjs` 的本地资讯流处理入口 | 直接 LLM |
| `fund-quarterly-research-system.md` + `fund-quarterly-research-user.md` | 基金季度研究 CLI：把单只基金结构化证据写成 Markdown 报告 | `scripts/fund-quarterly-research.mjs` | 直接 LLM |
| `research/financial-analysis.md` | 公司财务页“深入财务分析” | `src/modules/research/application/research-financial-analysis.ts`；页面组件为 `web/src/modules/company/pages/company-finance-page.ts` | taskd ChatGPT |
| `research/operating-analysis.md` | 公司研究页“完整投资研究” | `src/modules/research/application/research-investment-analysis.ts`；页面为 `web/src/modules/research/pages/investment-analysis-page.ts` | taskd ChatGPT |
| `earnings-recommendation.md` | 业绩候选研究 CLI 的最终提示词模板；当前只写入输出目录的 `prompt.md` | `scripts/earnings-research.mjs` | 无自动调用 |
| `macro.md` | 宏观分析页：中美宏观与跨资产研究 | `src/modules/macro/application/macro-analysis.ts` 的 `enqueueMacroAnalysis()` | taskd ChatGPT |
| `featured-report-whole.md` | 精选研报：单批全文翻译与总结 | `scripts/prepare-featured-report.mjs` → `scripts/lib/featured-report-batches.mjs` 的 `translateReport()` | 直接 LLM |
| `featured-report-glossary.md` + `featured-report-translate.md` + `featured-report-summary.md` | 精选研报：多批术语统一、分块翻译、提要汇总 | 同上，按 `kind` 动态读取文件 | 直接 LLM |

## 维护与验收

- 调整前先核对调用方输入、输出解析器和缓存键，不仅检查提示词措辞。保持占位符、JSON 字段、ID 和已约定标题；缺失值遵循消费者契约，不统一改成空字符串或零。
- 抽取和翻译只使用输入；财务、基金及业绩候选只解释已提供证据；研报发现、完整投资研究与宏观研究允许公开检索，但须标明时点与来源。
- `information-feed` 提示词参与持久化记录的 `promptHash`。修改需协调 `tagContract` 与历史契约登记，不能仅重建文本而忽略已有记录的可见性；本轮复核保留其现有规则，不改变提取契约。
- 基金模板由配置指定、业绩候选模板由 CLI 直接读取、精选研报模板按阶段动态读取，不在 `build:prompts` 文本导出清单内，并非未使用文件。
- Prompt 修改不自动重跑历史报告。精选研报已有 `content.json` 默认保留；需要完整新译文时使用新的 `--out` 目录，避免覆盖人工修改。
- 本轮逐项复核记录与人工验收样例见 [提示词复核](../docs/prompt-review-2026-09-27.md)。

## 已清理

以下旧提示词没有当前运行时使用，已从目录和 `scripts/build-prompts.mjs` 移除：

- `company/news-report-analyze-user.md`、`company/news-report-analyze-system.md`：新闻研报抽取不再维护单独模板，改为代码侧关键词粗筛后直接复用 `company/report-analyze-system.md` + `company/report-analyze-user.md`。
- `knowledge/enrich-structured-system.md`、`knowledge/enrich-structured-user.md`：旧的直接 CLI enrichment。当前 `process-knowledge-once.mjs` 已明确将该入口标记为 retired 并抛错；现行知识导入仅做主题筛选；资讯流由独立本地提取链路处理。
- `information-processing/document-analysis-user.md`：旧“信息整理”页面与单篇知识信息处理任务已移除，资讯流只使用本目录下的一组 System/User 提示词。
- `research/operating-analysis/` 下旧六阶段提示词：属于已删除的旧分阶段 runner（`company_baseline`、`industry_validation`、`operating_analysis`、`financial_analysis`、`valuation_inputs`、`valuation_conclusion`）以及后来撤下的低依赖阶段 Prompt。当前完整投资研究 API 使用上表中的单次最终报告 Prompt；确定性估值工作台不调用模型。

`src/generated/prompt-text.ts` 和 `scripts/generated/prompt-text.mjs` 是生成文件，应通过 `npm run build:prompts` 从本目录重建，不要手工编辑。
