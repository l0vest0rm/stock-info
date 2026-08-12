# Prompt 使用映射

本目录只保留当前仍有运行时入口的提示词。判断标准是：必须能从页面/API/CLI 入口追到实际发送点；仅被旧文档、旧生成产物或已删除 runner 提到的不保留。

## 调用方式

| 标记 | 实际链路 |
| --- | --- |
| `直接 LLM` | 本地 Node 运行时创建 `generic_raw_model` 任务，由本地 generic runner 通过 OpenAI/llm-proxy 执行；不是 taskd 的 ChatGPT WebQA。生产环境不允许触发。 |
| `taskd ChatGPT` | 页面/API 将任务提交到 taskd，`task_type=webqa.chatgpt.v1`，由 taskd 的 ChatGPT WebQA 执行。 |
| `无自动调用` | 只生成或保存 Prompt，当前代码不会自动提交模型任务。 |

## 当前保留的 Prompt

| Prompt 文件 | 页面/功能 | 调用入口 | 调用方式 |
| --- | --- | --- | --- |
| `company/report-analyze-system.md` + `company/report-analyze-user.md` | 公司研报页：读取研报正文后补充年度业绩预测和单一目标价；知识库新闻命中估值/评级关键词后也复用这套提取模板 | `src/modules/company/api/company.routes.ts` 的 `extractCompanyReportAnalysisByLlm()`；`extractCompanyNewsReportByLlm()` 在代码侧关键词粗筛通过后复用该模板 | 直接 LLM |
| `company/report-discovery.md` | 公司研报页“搜索近期公开研报” | `src/modules/company/api/company.routes.ts` 的 `submitCompanyReportDiscoveryTask()`；前端入口为 `web/src/modules/company/pages/company-report-page.ts` | taskd ChatGPT |
| `knowledge/topic-batch-system.md` + `knowledge/topic-batch-user.md` | 知识库导入：标题级 AI 产业链主题筛选，只有不确定批次才调用 | `scripts/process-knowledge-once.mjs` 的 `reviewTopicBatchWithLlm()` | 直接 LLM |
| `information-processing/document-analysis-system.md` + `information-processing/document-analysis-user.md` | 知识库单篇原文结构化抽取，生成可审计的信息记录和第三方预测字段 | `src/modules/knowledge/application/information-processing.ts` 的 `processInformationDocument()`；由本地信息处理任务触发 | 直接 LLM |
| `fund-quarterly-research-system.md` + `fund-quarterly-research-user.md` | 基金季度研究 CLI：把单只基金结构化证据写成 Markdown 报告 | `scripts/fund-quarterly-research.mjs` | 直接 LLM |
| `research/forecast-synthesis-system.md` + `research/forecast-synthesis-user.md` | 公司研究页“未来业绩预测”：把已审核纳入的来源预测整理成草稿，不创建新预测数字 | `src/modules/research/application/forecast-synthesis.ts`；页面组件为 `web/src/modules/research/components/forecast-workbench.ts` | 直接 LLM |
| `research/financial-analysis.md` | 公司财务页“深入财务分析” | `src/modules/research/application/research-financial-analysis.ts`；页面组件为 `web/src/modules/company/pages/company-finance-page.ts` | taskd ChatGPT |
| `research/operating-analysis-system.md` + `research/operating-analysis.md` | 公司研究页“完整投资研究” | `src/modules/research/application/research-investment-analysis.ts`；页面为 `web/src/modules/research/pages/investment-analysis-page.ts` | taskd ChatGPT |
| `earnings-recommendation.md` | 业绩候选研究 CLI 的最终提示词模板；当前只写入输出目录的 `prompt.md` | `scripts/earnings-research.mjs` | 无自动调用 |

## 已清理

以下两类没有当前运行时使用，已从目录和 `scripts/build-prompts.mjs` 移除：

- `company/news-report-analyze-user.md`、`company/news-report-analyze-system.md`：新闻研报抽取不再维护单独模板，改为代码侧关键词粗筛后直接复用 `company/report-analyze-system.md` + `company/report-analyze-user.md`。
- `knowledge/enrich-structured-system.md`、`knowledge/enrich-structured-user.md`：旧的直接 CLI enrichment。当前 `process-knowledge-once.mjs` 已明确将该入口标记为 retired 并抛错；现行知识处理使用主题筛选和单篇信息处理链路。
- `research/operating-analysis/` 下旧六阶段提示词：属于已删除的旧分阶段 runner（`company_baseline`、`industry_validation`、`operating_analysis`、`financial_analysis`、`valuation_inputs`、`valuation_conclusion`）以及后来撤下的低依赖阶段 Prompt。当前完整投资研究 API 使用上表中的单次最终报告 Prompt；确定性估值工作台不调用模型。

`src/generated/prompt-text.ts` 和 `scripts/generated/prompt-text.mjs` 是生成文件，应通过 `npm run build:prompts` 从本目录重建，不要手工编辑。
