# 公司投资分析低依赖分阶段改造 TODO

状态：`implementation-complete; verification-pending`；这是目标设计的实施清单，尚未授权生产代码、数据库或远端变更。

设计依据：[`公司投资分析低依赖分阶段架构设计.md`](./公司投资分析低依赖分阶段架构设计.md)。旧六阶段契约 [`公司投资分析大模型分阶段调用规范.md`](./公司投资分析大模型分阶段调用规范.md) 保持独立；在 P7-03/P7-04 真实验证完成前不得把静态实现描述为已验收。

## 使用规则

- `[ ]`：尚未完成或尚未完成真实验证；`[x]`：开发实现已完成。端到端/类型/页面验证仍以 P7-03/P7-04 的未勾选项为准。
- 每项必须记录目标文件/模块、前置依赖、完成定义和验证证据；只有静态检查通过不能单独标记端到端完成。
- `partial`、`blocked`、`failed` 和不可比数据必须保留原因与影响范围，不得用空值、零或重试掩盖。
- 所有本地 LLM 执行仍必须由 `LLM_RUNTIME=local` 的 Node runtime 发起；生产 Cloudflare Worker 不调用 LLM。
- 本清单默认不授权生产部署、生产 Worker 变更、远端 D1 migration/apply、远端数据清理、Cookie/密钥写入或生产任务重跑。需要时另建变更申请并取得明确授权。

## P0：契约冻结与测试基线

- [x] **P0-01 冻结新旧契约边界**
  - 目标文件/模块：`docs/公司投资分析低依赖分阶段架构设计.md`、`docs/公司投资分析大模型分阶段调用规范.md`、`config/research-operating-analysis.json`、`src/modules/research/application/research-operating-analysis.ts`。
  - 前置依赖：无；先完成当前 git diff 和本地任务状态清点。
  - 完成定义：新协议拥有独立 `promptVersion`/协议版本；旧六阶段继续作为迁移前唯一运行契约；文档明确禁止混写、双写和旧形状 adapter。
  - 验证命令/证据：已新增 `config/research-operating-analysis-stages.json` 与 registry wrapper，明确 `investment-analysis.low-dependency.v1`/`research_operating_analysis_low_dependency` 和旧 `investment-analysis.staged.v1`/`research_operating_analysis` 的 disjoint identity；静态/测试命令留待 P7 统一执行（本批未运行）。

- [x] **P0-02 建立静态依赖与内容基线**
  - 目标文件/模块：`scripts/research-operating-analysis-runner.mjs`、`scripts/lib/operating-analysis-stage-plan.mjs`、六个现有 operating-analysis Prompt、`scripts/lib/operating-analysis-report.mjs`。
  - 前置依赖：P0-01。
  - 完成定义：基线记录当前六个 stage key、依赖图、输入财务 snapshot、11 个 required headings、报告组装范围和旧 artifact 表使用状态。
  - 验证命令/证据：已完成只读基线审计并新增 `scripts/lib/research-operating-analysis-stage-registry.{mjs,test.mjs}`；现有旧实现仍由 `scripts/research-operating-analysis-runner.mjs`、`src/modules/research/application/research-operating-analysis.ts`、`scripts/lib/operating-analysis-financial-snapshot.mjs`、`scripts/lib/operating-analysis-report.mjs` 所有；静态/测试命令留待 P7 统一执行（本批未运行）。

- [x] **P0-03 固定契约测试入口**
  - 目标文件/模块：`scripts/lib/operating-analysis-stage-plan.test.mjs`、`src/modules/research/application/research-operating-analysis.test.mjs`、新增低依赖 contract/projection 测试文件。
  - 前置依赖：P0-01、P0-02。
  - 完成定义：测试覆盖阶段 key/output kind、依赖波次、状态枚举、manifest schema 和旧协议隔离；测试 fixture 不依赖真实模型或生产服务。
  - 验证命令/证据：已新增 `scripts/lib/research-operating-analysis-stage-registry.test.mjs` 与 `scripts/lib/research-artifact-projection.test.mjs`，覆盖 S0-S12 registry、scope/fallback waves、legacy identity 隔离、schema/owner、terminal status、manifest schema/graph 和 projection allow-list；执行命令留待 P7 统一验证（本批未运行）。

## P1：S0.1 `engineering_baseline`、S0.2 `local_routing_match` 与 source registry

- [x] **P1-01 定义 S0.1 工程基线 schema**
  - 目标文件/模块：新增 `src/modules/research/application/research-context.ts`（或等价模块）、`scripts/lib/research-context.mjs`、`config/research-operating-analysis.json`。
  - 前置依赖：P0；确认现有公司/证券映射、报告边界、财务 read-model 和市场快照 owner。
  - 完成定义：S0.1 输出 `engineering_baseline`、company/security、asOf、财务/市场快照、source/material IDs、`companyScope`、候选模板、input fingerprint 和质量缺口；不输出模型判断。
  - 验证命令/证据：已新增 `src/modules/research/application/research-context.ts`、`scripts/lib/research-context.mjs` 及其脚本/typed fixtures（`scripts/lib/research-context.test.mjs`、`src/modules/research/application/research-context.test.mjs`）；fixture 覆盖稳定 fingerprint/缺口，但命令执行留待 P7 统一验证（本批未运行）。

- [x] **P1-02 建立并门禁 S0.2 本地路由**
  - 目标文件/模块：`scripts/lib/research-scope-industry-routing.mjs`、`config/research-analysis-template-registry.json`、runner 和研究 API/UI。
  - 前置依赖：P1-01；必须明确公司主体与上市证券映射。
  - 完成定义：S0.2 只按受控注册表匹配可审计主营、产品、下游和行业事实；unique/zero/ambiguous/insufficient 均显式记录，未确认时阻断 S1–S12；人工模板确认校验注册表 ID 并写入不可变审计。
  - 验证命令/证据：`scripts/lib/research-scope-industry-routing.test.mjs` 覆盖确定性匹配、四类路由状态、人工确认和禁止模型选模板；API 读写 endpoint、migration 和 low runner 已接入。

- [x] **P1-03 建立 source registry**
  - 目标文件/模块：`src/modules/research/domain` 的 source/provenance 类型、`src/shared/local-job-protocol.ts` 的输入引用、相关 D1 migration（如需要）。
  - 前置依赖：P1-01；来源权限和现有 source package owner 清点完成。
  - 完成定义：每个来源版本有 `sourceId`、URL、标题、发布日期、主体、来源角色、抓取/可用时间和内容 fingerprint；S0.1 只注册来源，不把来源变成事实。
  - 验证命令/证据：已新增 `config/research-source-registry.json` 和 JS/TS `registerResearchSources`，稳定 ID 按来源版本去重、内容 fingerprint 变化生成新 ID；脚本与 typed fixtures 已覆盖重复/版本变化，命令留待 P7（本批未运行）。

## P2：artifact ID、字段投影与追溯

- [x] **P2-01 扩展 terminal artifact contract**
  - 目标文件/模块：`src/shared/local-job-protocol.ts`、`migrations/0107_generic_llm_task_protocol.sql` 或新的向前迁移、`src/modules/research/application/research-operating-analysis.ts`。
  - 前置依赖：P0、P1；不得删除旧数据或旧表。
  - 完成定义：artifact 保存 `artifactId`、`stepKey`、`stageVersion`、`inputFingerprint`、`upstreamArtifactIds`、source/claim/evidence/unknown IDs、status、blocked/error 和 terminal metadata；complete stage 真正写入 upstream IDs。
  - 验证命令/证据：已新增前向迁移 `migrations/0108_research_operating_analysis_artifact_contract.sql`，并在 `src/shared/local-job-protocol.ts` 持久化/读取 stageVersion、inputFingerprint、upstream/source/claim/evidence/unknown IDs 和 projectionVersion；未提供 lineage 字段的既有 generic Web Search/information-processing 调用使用空数组安全默认值，显式空/非法/重复 ID 拒绝。代码/fixture 已完成，`npm run test:research` 与 D1 lease/迟到 attempt 验证留待 P7 统一执行（本批未运行）。

- [x] **P2-02 实现字段 projection helper**
  - 目标文件/模块：新增 `scripts/lib/research-artifact-projection.mjs`（或等价共享 helper）、各阶段 runner/application 调用点。
  - 前置依赖：P2-01；S1–S12 字段 owner 表冻结。
  - 完成定义：下游只获得声明的字段和 ID，不获得不必要的完整 Markdown；projection 带 schema/version、来源 artifact IDs 和缺口；拒绝未知字段静默泄漏。
  - 验证命令/证据：已新增 `config/research-artifact-projections.json` 与 `scripts/lib/research-artifact-projection.mjs`；projection 带 schema/version、来源 artifact IDs、输入 fingerprint、引用 IDs 和 analysis gaps，按 stage allow-list 拒绝未知字段且不泄漏完整 Markdown；fixture 已覆盖允许/禁止字段、重复/位置 ID，`node --check` 与运行留待 P7（本批未运行）。

- [x] **P2-03 建立 claim/evidence/assumption/risk ID 追溯**
  - 目标文件/模块：研究领域类型、JSON/Markdown 结构校验、`research_operating_analysis_runs` projection。
  - 前置依赖：P2-01、P2-02。
  - 完成定义：每个判断可回到 evidence/source；每个假设可回到 judgment/evidence；每个风险可回到事件、财务项目、估值影响和监测阈值；无位置索引引用。
  - 验证命令/证据：`research-artifact-projection.mjs` 的 manifest validator 按声明 ID 校验 `source → evidence → claim → judgment → assumption/risk → calculation → report`，拒绝未知/重复/位置引用；`scripts/lib/research-artifact-projection.test.mjs` 提供一条完整链和失败 fixture。测试执行留待 P7（本批未运行）。

## P3：拆分 `industry_validation`

- [x] **P3-01 拆 Prompt 和输出 schema**
  - 目标文件/模块：新增 `prompts/research/operating-analysis/industry-structure.md`、`supply-demand-cycle.md`、`competition-peers.md`；`scripts/build-prompts.mjs`；生成的 Prompt exports。
  - 前置依赖：P1-02、P2-02；先保留旧 Prompt/version 可回读。
  - 完成定义：原 `validatedIndustryProfile`、`valueChain`、`profitPool`、`supplyDemandAndCycle`、`peerSet`、冲突和第三方预测全部映射到三个新域，无字段静默丢失；每域有独立禁止事项和 manifest。
  - 验证命令/证据：已新增三份 JSON envelope Prompt；S1–S7 registry 改为 `outputKind=json`，每份 envelope 含受约束的 `markdown`、结构化域字段和 source/claim/evidence/unknown IDs；已运行 `node scripts/build-prompts.mjs` 更新 `src/generated/prompt-text.ts` 与 `scripts/generated/prompt-text.mjs`。Prompt contract test 与逐字段迁移矩阵留待 P7（本批未运行）。

- [x] **P3-02 更新 runner/API stage registry**
  - 目标文件/模块：`scripts/research-operating-analysis-runner.mjs`、`src/modules/research/application/research-operating-analysis.ts`、研究 API 路由和阶段读模型。
  - 前置依赖：P3-01、P2-01；新的 `promptVersion` 已冻结。
  - 完成定义：三个域不互相读全文；S0.1/S0.2 与确定性 `scopeProjection` 是唯一范围输入；未确认路由显式 blocked，不解析 S1 Markdown，也不引入 JSON sidecar。
  - 验证命令/证据：`config/research-operating-analysis-stages.json`、`scripts/lib/operating-analysis-stage-plan.mjs`、`scripts/research-operating-analysis-low-dependency-runner.mjs` 和 low-dependency application/API route family 已固定独立 task/protocol、scope/fallback wave 与 S0 scope projection；旧六阶段 runner/app/API 未改用新 key。阶段 registry/graph test、`node --check` 与 API 请求验证留待 P7（本批未运行）；当前 low runner 仍是 contract/input-builder，真实 LLM polling wiring 明确留在 P7。

- [x] **P3-03 保留行业深度和冲突**
  - 目标文件/模块：三个新 Prompt、manifest validator、报告 projection。
  - 前置依赖：P3-01。
  - 完成定义：行业边界、利润池、量价成本资本、周期/库存/价格、同行可比性、第三方预测、支持/反驳公司主张和 unknown 均可从新 artifacts 追溯。
  - 验证命令/证据：三份 Prompt 显式保留边界、量价成本/资本、周期、同行可比性、第三方预测、支持/反驳和 unknown；`config/research-artifact-projections.json` 将 `markdown` 与 manifest 字段纳入各域 allow-list，禁止全文或未声明字段泄漏。300308.SZ artifact replay 与行业断言/不可比排名测试留待 P7（本批未运行）。

## P4：公司事实/经营驱动/财务质量/市场估值并行域

- [x] **P4-01 建立 `company_facts` 与 `company_operating_drivers`**
  - 目标文件/模块：新增两份 Prompt、runner stage definitions、domain schema 和报告 projection。
  - 前置依赖：P1、P2、P3 的 scope/ID 约束。
  - 完成定义：公司正式披露、管理层表述、会计/治理事实与公司特有量价成本/订单/产能/增长驱动分属两个 owner；不重复搜索三表数值。
  - 验证命令/证据：`company-facts.md` 与 `company-operating-drivers.md` 分离 owner、禁止事项和 manifest；financialSnapshot 仅以 `financialSnapshotRef`/S0.1 projection 进入 S1；S2-S5 只接收确认路由和 S0 projection，不传 S1 全文。Prompt/build/typecheck、字段 owner matrix 与缺证据 fixture 留待 P7（本批未运行）。

- [x] **P4-02 建立 `financial_quality`**
  - 目标文件/模块：`scripts/lib/operating-analysis-financial-snapshot.mjs`、财务 Prompt、财务 domain 校验、stage registry。
  - 前置依赖：P1 S0.1 financial snapshot、P1 S0.2 routing、P2 projection；财务来源 policy 不变。
  - 完成定义：只读取结构化三表、确定性指标和授权附注来源；覆盖利润质量、现金转换、营运资本、资本效率、治理、资本配置、债务和行业压力；不读取其他模型判断。
  - 验证命令/证据：`financial-quality.md` 仅声明 S0.1 financialSnapshot 输入；`financialSnapshotForStage` 只投影结构化三表与确定性指标；`validateFinancialQualitySnapshot` 已接入 low runner 的 S6 input gate，缺期间/币种/单位/来源为 blocking gap，金融主体返回 `not_applicable`。fixture 与 `npm run test:research` 留待 P7（本批未运行）。

- [x] **P4-03 建立 `market_valuation_facts`**
  - 目标文件/模块：市场/证券估值 domain、S0 market snapshot、Prompt 和 stage registry。
  - 前置依赖：P1 证券映射、P2 IDs；不得扩展 K 线来源。
  - 完成定义：记录价格、市值、股本、币种、证券权利、历史估值观察、可比性和可用估值方法；不输出公司质量判断、情景或目标价。
  - 验证命令/证据：`buildOperatingAnalysisMarketSnapshot` 固定 `source=xueqiu` 并保留 security/rights/shares/historicalValuation；JS/TS S0 normalizers 透传这些字段并纳入 stable input fingerprint；S7 Prompt 禁止质量判断、情景和目标价，projection allow-list 已覆盖市场事实字段。市场阻断 fixture、`npm run typecheck` 与来源 policy review 留待 P7（本批未运行）。

- [x] **P4-04 验证并行波次与资源上限**
  - 目标文件/模块：runner wave planner、local job worker concurrency、研究页面 stage read model。
  - 前置依赖：P4-01、P4-02、P4-03。
  - 完成定义：可靠 scope 模式下 S1–S7 同波运行，兄弟失败经 `Promise.allSettled` settle 后才传播；每阶段显示 attempt/耗时/blocked。
  - 验证命令/证据：`runResearchOperatingAnalysisStageWaves` 已由 registry 驱动并支持 `resourceCap`、Promise.allSettled sibling settling 和 declared dependency blocked propagation；low application/API read model 暴露 stage status、attempt、elapsed metadata、blocked/error 与 artifact IDs。页面仍消费旧六阶段端点，低依赖 UI 接线属于 P7；stage-plan test、并行事件 trace 未运行（本批禁止验证命令）。

## P5：`operating_thesis`（已实现；验证 deferred）

- [x] **P5-01 连接 S1–S5 的经营因果链**
  - 目标文件/模块：新增 operating thesis Prompt、manifest projection、runner/app stage registry。
  - 前置依赖：P3、P4-01、P2-03；S1–S5 的终态 schema 已冻结。
  - 完成定义：建立需求→量价→收入→利润率的可证伪链，记录支持/反面证据、替代解释、关键变量和失效条件；不新搜索、不生成估值。
  - 验证命令/证据：已实现 `scripts/lib/operating-analysis-operating-thesis.mjs`、S8 Prompt、projection allow-list 和因果链 fixture；`node --test`/`npm run build:prompts`/真实 runner 验证 deferred（本批未运行）。

- [x] **P5-02 更新章节 owner 与缺口回流**
  - 目标文件/模块：报告章节 projection、UI/API stage status、evidenceGap/requeue handling。
  - 前置依赖：P5-01。
  - 完成定义：S8 只补跨域判断，不重写 S1–S5；缺口可定向回流到对应事实域；不允许用 S8 新事实掩盖缺口。
  - 验证命令/证据：`deriveOperatingThesisRequeueTargets` 保留最小事实域集合，blocked/partial 状态与输入 gap 已实现；API/UI 状态断言和端到端验证 deferred（本批未运行）。

## P6：情景估值、确定性计算与最终结论（已实现；验证 deferred）

- [x] **P6-01 建立 `scenario_valuation`**
  - 目标文件/模块：情景/估值输入 Prompt、JSON schema、runner/app registry、manifest graph。
  - 前置依赖：P5、P4-02、P4-03、P2-03。
  - 完成定义：S9 只读 S8 judgments、S6 financial observations、S7 market observations 和 S0；输出三情景、方法选择、DCF/反向/敏感性请求、风险传导和监测指标；不得输出未计算目标价。
  - 验证命令/证据：已实现 S9 Prompt、三情景/DCF/反向/敏感性请求校验和 `blockedValuationItems`；JSON schema/units/periods fixture、`npm run test:research` 与真实任务验证 deferred（本批未运行）。

- [x] **P6-02 迁移 deterministic valuation**
  - 目标文件/模块：`scripts/research-operating-analysis-runner.mjs` 中计算逻辑或新的 deterministic valuation module、valuation domain tests。
  - 前置依赖：P6-01；确认行业方法和单位/股本/净债务输入契约。
  - 完成定义：S10 只消费 S9 已确认输入；DCF、反向求解、敏感性、终值占比、EV→equity→per-share 和阻断 trace 可复算；模型不能写入计算结果。
  - 验证命令/证据：已新增 `scripts/lib/operating-analysis-deterministic-valuation.mjs`，覆盖 DCF、反向求解、敏感性、终值占比、EV→equity→per-share、公式/单位/舍入 trace，并由旧 runner/app 持久化独立 S10 artifact；`node --test`、边界和金融行业 fixture 验证 deferred（本批未运行）。

- [x] **P6-03 建立 `investment_conclusion`**
  - 目标文件/模块：估值结论 Prompt、stage registry、provenance projection、研究 API/read model。
  - 前置依赖：P6-01、P6-02、P2-03。
  - 完成定义：S11 只解释 S9/S10 和 source/claim manifest，覆盖估值隐含经营要求、反证、风险和监测；不新搜索、不改假设/数字、不重写章节2–8。
  - 验证命令/证据：已实现 S11 Prompt、9–12 章节/计算 ID/来源 manifest 门禁及 blocked deterministic fixture；Prompt contract、内联链接和 API/read-model 验证 deferred（本批未运行）。

## P7：确定性组装、恢复迁移与真实本地验证

- [x] **P7-01 实现 S12 确定性报告组装**
  - 目标文件/模块：`scripts/lib/operating-analysis-report.mjs`、`src/modules/research/application/research-operating-analysis-low-dependency.ts`、低依赖报告 API/read model、研究页面。
  - 前置依赖：P4、P5、P6；章节 owner matrix 已冻结。
  - 完成定义：完整十二章按设计映射组装；S1–S7 详细域正文直接进入对应章节；S11 不重写2–8；报告 projection 记录 run/artifact/source manifest 和门禁。
  - 验证命令/证据：开发实现与契约 fixture 已写入；S12 章节/来源/状态门禁在 stage-plan/report fixture 中通过。低依赖页面已显示 S0.2 路由状态、候选、理由、采集依据和人工确认表单。`npm run test:investment-analysis` 已执行但因本地 `300308.SZ` 缺少 operating-company identity 失败（不是 S12 终态成功证据）；真实 low-dependency acceptance 因未确认路由或 S1/S6 incomplete stream 保持 blocked，故不把报告描述为完成。

- [x] **P7-02 实现恢复、定向重跑和旧 artifact 隔离**
  - 目标文件/模块：generic task/run/artifact protocol、低依赖 runner recovery、`0107/0108` migration、低依赖 API/UI；旧六阶段 read/write 路径保持独立且不删除。
  - 前置依赖：P2、P3、P4、P5、P6；备份方案和精确数据范围已记录。
  - 完成定义：重启/lease 过期只重跑未终态及下游；完成 artifact 保留；来源/财务/市场变化按最小集合定向重跑；旧六阶段任务不与新 run 混写；不删除未授权数据。
  - 验证命令/证据：已补 cross-run compatible-artifact link、changed-fingerprint/downstream invalidation、sibling preservation、unknown contract rejection、legacy isolation、targeted rerun 与 interruption recovery 的测试/验收代码。恢复 fixture 批次（shared protocol、low runner/application、stage registry/plan）通过 30/30，覆盖 complete/not_applicable 精确复用、fingerprint/upstream/projection/status 不兼容、依赖后代失效、兄弟阶段保留及旧协议隔离；`npm run test:research` 通过 255 tests。真实 targeted rerun（run `llm-run:fe83e1fe-013a-467b-a665-8a22f4fe324c`，lineage `llm-run:43e385b0-69c4-46c0-9ff6-69cce6e077f8`，attempt 6）因 `company_facts`/`financial_quality` incomplete stream blocked，旧 S0/S7 为 `partial`，没有合法 complete artifact 可复用（所有 stage `reused=false`）；因此不把“真实中断复用”描述为已证明。

- [ ] **P7-03 本地真实任务和 API 终态验证**
  - 目标文件/模块：`./start-local.sh`、`scripts/local-job-worker.mjs`、研究 API、D1/SQLite read model、报告 projection。
  - 前置依赖：P7-01、P7-02；本地凭据、来源和 fixture 已准备；不触碰生产。
  - 完成定义：至少一次本地任务从 enqueue→claim→各波次→S10→S12 完成；API 读到终态、runId、artifact IDs、报告十二章和缺口；中断后从合法边界恢复有证据。
  - 验证命令/证据（仍未勾选）：本地 supervisor/Node runtime 与 `GET http://127.0.0.1:8000/api/health` 正常（`d1:true`）；真实验证必须先证明 S0.1→S0.2 路由状态和人工确认审计，再执行 refresh→claim→S1–S7→S8–S12。此前 run 的 `company_facts`（HTTP 200、18,967 bytes，无 `response.completed`）与 `financial_quality`（HTTP 200、4,452,278 bytes，44,072 字符后无 `response.completed`）失败，S12 report gate 为 `blocked`，没有完整 S0–S12 成功或合法中断复用证据。

- [ ] **P7-04 完成静态、类型和页面验收记录**
  - 目标文件/模块：全量新旧相关文件、docs、generated Prompt、web read model。
  - 前置依赖：P7-01、P7-02、P7-03。
  - 完成定义：无未解释 diff、无 stale generated Prompt、无旧 stage key 混用、无隐藏 partial/blocked；验证结果和跳过项写入交付记录。
  - 验证命令/证据（仍未勾选）：`git diff --check`、`npm run typecheck`、`npm run build:local`、`npm run test:research`（255 tests）及 `npm run test:investment-analysis-cli`（3/3）均通过；recovery fixture 批次 30/30 通过。`npm run test:investment-analysis` 因本地 `300308.SZ: operating company is absent` 失败；`npm run test:smoke:pages` 为 86 passed、3 failed：宏观 SOFR 数据 vintage、港股 Eastmoney 财务数据、MU.US options 请求中止，均未触及本轮 low-dependency 文件/行为。故 P7-04 的静态/页面验收仍保留未勾选，并保留这些失败原因。

## 延后事项与生产边界

- [ ] 生产 Cloudflare Worker、远端 D1 migration/apply、Worker deploy、生产任务重跑和生产数据清理：**不属于本批默认授权**，需单独变更请求、备份、精确范围、审批和生产健康/API/报告证明。
- [ ] 旧六阶段历史报告、旧 artifact 表和本地任务数据的清理：只有完成备份、范围确认和新协议本地重生成证明后，另行执行；不得以“新读模型可用”推断删除安全。
