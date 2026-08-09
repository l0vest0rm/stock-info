# 公司投资分析低依赖分阶段改造 TODO

状态：`pending`；这是目标设计的实施清单，尚未授权代码、数据库或生产变更。

设计依据：[`公司投资分析低依赖分阶段架构设计.md`](./公司投资分析低依赖分阶段架构设计.md)。迁移前运行时仍遵循旧六阶段契约 [`公司投资分析大模型分阶段调用规范.md`](./公司投资分析大模型分阶段调用规范.md)；在 P7 完成前不得混用两套阶段 key、Prompt、artifact 依赖或报告投影。

## 使用规则

- `[ ]`：尚未完成；`[x]`：实现、验证和证据均已完成。
- 每项必须记录目标文件/模块、前置依赖、完成定义和验证证据；只有静态检查通过不能单独标记端到端完成。
- `partial`、`blocked`、`failed` 和不可比数据必须保留原因与影响范围，不得用空值、零或重试掩盖。
- 所有本地 LLM 执行仍必须由 `LLM_RUNTIME=local` 的 Node runtime 发起；生产 Cloudflare Worker 不调用 LLM。
- 本清单默认不授权生产部署、生产 Worker 变更、远端 D1 migration/apply、远端数据清理、Cookie/密钥写入或生产任务重跑。需要时另建变更申请并取得明确授权。

## P0：契约冻结与测试基线

- [ ] **P0-01 冻结新旧契约边界**
  - 目标文件/模块：`docs/公司投资分析低依赖分阶段架构设计.md`、`docs/公司投资分析大模型分阶段调用规范.md`、`config/research-operating-analysis.json`、`src/modules/research/application/research-operating-analysis.ts`。
  - 前置依赖：无；先完成当前 git diff 和本地任务状态清点。
  - 完成定义：新协议拥有独立 `promptVersion`/协议版本；旧六阶段继续作为迁移前唯一运行契约；文档明确禁止混写、双写和旧形状 adapter。
  - 验证命令/证据：`git diff --check`；`rg -n "company_baseline|industry_validation|investment-analysis.staged.v1" scripts src/modules docs`；保存旧/新契约差异表。

- [ ] **P0-02 建立静态依赖与内容基线**
  - 目标文件/模块：`scripts/research-operating-analysis-runner.mjs`、`scripts/lib/operating-analysis-stage-plan.mjs`、六个现有 operating-analysis Prompt、`scripts/lib/operating-analysis-report.mjs`。
  - 前置依赖：P0-01。
  - 完成定义：基线记录当前六个 stage key、依赖图、输入财务 snapshot、11 个 required headings、报告组装范围和旧 artifact 表使用状态。
  - 验证命令/证据：`node --check scripts/research-operating-analysis-runner.mjs`；`rg -n "dependsOn|stageWaves|upstreamArtifacts|OPERATING_ANALYSIS_REQUIRED_HEADINGS" scripts src/modules`；保存静态基线报告。

- [ ] **P0-03 固定契约测试入口**
  - 目标文件/模块：`scripts/lib/operating-analysis-stage-plan.test.mjs`、`src/modules/research/application/research-operating-analysis.test.mjs`、新增低依赖 contract/projection 测试文件。
  - 前置依赖：P0-01、P0-02。
  - 完成定义：测试覆盖阶段 key/output kind、依赖波次、状态枚举、manifest schema 和旧协议隔离；测试 fixture 不依赖真实模型或生产服务。
  - 验证命令/证据：`npm run test:research`、`npm run test:investment-analysis-cli`；记录测试数量和失败输出。

## P1：S0 `research_context`、`scopeEnvelope` 与 source registry

- [ ] **P1-01 定义 S0 只读上下文 schema**
  - 目标文件/模块：新增 `src/modules/research/application/research-context.ts`（或等价模块）、`scripts/lib/research-context.mjs`、`config/research-operating-analysis.json`。
  - 前置依赖：P0；确认现有公司/证券映射、报告边界、财务 read-model 和市场快照 owner。
  - 完成定义：输出 `contextVersion`、`researchTaskId`、`asOf`、company/security、reportingBoundary、financialSnapshot、marketSnapshot、inputFingerprint 和质量缺口；不输出模型判断。
  - 验证命令/证据：新增 schema/fixture 测试；`npm run typecheck`；记录同一输入产生稳定 fingerprint 的证据。

- [ ] **P1-02 生成并门禁 `scopeEnvelope`**
  - 目标文件/模块：S0 context builder、公司/证券映射 application、`config/research-*` 行业配置和对应测试。
  - 前置依赖：P1-01；必须明确公司主体与上市证券映射。
  - 完成定义：`scopeEnvelope` 包含产品、客户、地区、用途、重要分部和不确定边界；无法确认时为 `null` 并生成 `analysisGap`，不得以 ticker/name 推断行业。
  - 验证命令/证据：覆盖已确认、冲突、缺失和多业务公司 fixture；运行 `npm run test:research`；保存 gap/blocked 读模型样本。

- [ ] **P1-03 建立 source registry**
  - 目标文件/模块：`src/modules/research/domain` 的 source/provenance 类型、`src/shared/local-job-protocol.ts` 的输入引用、相关 D1 migration（如需要）。
  - 前置依赖：P1-01；来源权限和现有 source package owner 清点完成。
  - 完成定义：每个来源版本有 `sourceId`、URL、标题、发布日期、主体、来源角色、抓取/可用时间和内容 fingerprint；S0 只注册来源，不把来源变成事实。
  - 验证命令/证据：source registry schema/round-trip 测试；`npm run typecheck`；用同一来源重复注册验证去重和版本变化。

## P2：artifact ID、字段投影与追溯

- [ ] **P2-01 扩展 terminal artifact contract**
  - 目标文件/模块：`src/shared/local-job-protocol.ts`、`migrations/0107_generic_llm_task_protocol.sql` 或新的向前迁移、`src/modules/research/application/research-operating-analysis.ts`。
  - 前置依赖：P0、P1；不得删除旧数据或旧表。
  - 完成定义：artifact 保存 `artifactId`、`stepKey`、`stageVersion`、`inputFingerprint`、`upstreamArtifactIds`、source/claim/evidence/unknown IDs、status、blocked/error 和 terminal metadata；complete stage 真正写入 upstream IDs。
  - 验证命令/证据：`npm run test:research`；针对迟到 attempt、错误 lease、重复 terminal write 和 artifact ID 查询保存 D1 fixture 证据。

- [ ] **P2-02 实现字段 projection helper**
  - 目标文件/模块：新增 `scripts/lib/research-artifact-projection.mjs`（或等价共享 helper）、各阶段 runner/application 调用点。
  - 前置依赖：P2-01；S1–S12 字段 owner 表冻结。
  - 完成定义：下游只获得声明的字段和 ID，不获得不必要的完整 Markdown；projection 带 schema/version、来源 artifact IDs 和缺口；拒绝未知字段静默泄漏。
  - 验证命令/证据：projection fixture 断言允许/禁止字段；`node --check` 相关脚本；记录 Prompt 输入大小和字段集合对比。

- [ ] **P2-03 建立 claim/evidence/assumption/risk ID 追溯**
  - 目标文件/模块：研究领域类型、JSON/Markdown 结构校验、`research_operating_analysis_runs` projection。
  - 前置依赖：P2-01、P2-02。
  - 完成定义：每个判断可回到 evidence/source；每个假设可回到 judgment/evidence；每个风险可回到事件、财务项目、估值影响和监测阈值；无位置索引引用。
  - 验证命令/证据：新增 manifest graph test；检查一条完整 `source → evidence → judgment → assumption/risk → calculation → report` 链。

## P3：拆分 `industry_validation`

- [ ] **P3-01 拆 Prompt 和输出 schema**
  - 目标文件/模块：新增 `prompts/research/operating-analysis/industry-structure.md`、`supply-demand-cycle.md`、`competition-peers.md`；`scripts/build-prompts.mjs`；生成的 Prompt exports。
  - 前置依赖：P1-02、P2-02；先保留旧 Prompt/version 可回读。
  - 完成定义：原 `validatedIndustryProfile`、`valueChain`、`profitPool`、`supplyDemandAndCycle`、`peerSet`、冲突和第三方预测全部映射到三个新域，无字段静默丢失；每域有独立禁止事项和 manifest。
  - 验证命令/证据：`npm run build:prompts`；Prompt contract test；逐字段迁移矩阵。

- [ ] **P3-02 更新 runner/API stage registry**
  - 目标文件/模块：`scripts/research-operating-analysis-runner.mjs`、`src/modules/research/application/research-operating-analysis.ts`、研究 API 路由和阶段读模型。
  - 前置依赖：P3-01、P2-01；新的 `promptVersion` 已冻结。
  - 完成定义：三个域不互相读全文；可靠 scope 模式下与 `company_facts` 并行；无 scope 模式只接收 S1 `companyScope`。
  - 验证命令/证据：阶段 registry/graph test；`node --check scripts/research-operating-analysis-runner.mjs`；API read-model 显示三个域和状态。

- [ ] **P3-03 保留行业深度和冲突**
  - 目标文件/模块：三个新 Prompt、manifest validator、报告 projection。
  - 前置依赖：P3-01。
  - 完成定义：行业边界、利润池、量价成本资本、周期/库存/价格、同行可比性、第三方预测、支持/反驳公司主张和 unknown 均可从新 artifacts 追溯。
  - 验证命令/证据：使用 300308.SZ 或脱敏 fixture 做静态 artifact replay；确认无“行业增长=公司增长”或不可比排名。

## P4：公司事实/经营驱动/财务质量/市场估值并行域

- [ ] **P4-01 建立 `company_facts` 与 `company_operating_drivers`**
  - 目标文件/模块：新增两份 Prompt、runner stage definitions、domain schema 和报告 projection。
  - 前置依赖：P1、P2、P3 的 scope/ID 约束。
  - 完成定义：公司正式披露、管理层表述、会计/治理事实与公司特有量价成本/订单/产能/增长驱动分属两个 owner；不重复搜索三表数值。
  - 验证命令/证据：Prompt/build/typecheck；字段 owner matrix；缺证据时 `unknown`/`evidenceGap` 通过。

- [ ] **P4-02 建立 `financial_quality`**
  - 目标文件/模块：`scripts/lib/operating-analysis-financial-snapshot.mjs`、财务 Prompt、财务 domain 校验、stage registry。
  - 前置依赖：P1 S0 financial snapshot、P2 projection；财务来源 policy 不变。
  - 完成定义：只读取结构化三表、确定性指标和授权附注来源；覆盖利润质量、现金转换、营运资本、资本效率、治理、资本配置、债务和行业压力；不读取其他模型判断。
  - 验证命令/证据：财务 snapshot fixture、缺字段/金融行业不适用 fixture；`npm run test:research`；记录来源/期间/单位门禁。

- [ ] **P4-03 建立 `market_valuation_facts`**
  - 目标文件/模块：市场/证券估值 domain、S0 market snapshot、Prompt 和 stage registry。
  - 前置依赖：P1 证券映射、P2 IDs；不得扩展 K 线来源。
  - 完成定义：记录价格、市值、股本、币种、证券权利、历史估值观察、可比性和可用估值方法；不输出公司质量判断、情景或目标价。
  - 验证命令/证据：市场事实 fixture、跨证券权利/币种/股本阻断 fixture；`npm run typecheck`；来源 policy review。

- [ ] **P4-04 验证并行波次与资源上限**
  - 目标文件/模块：runner wave planner、local job worker concurrency、研究页面 stage read model。
  - 前置依赖：P4-01、P4-02、P4-03。
  - 完成定义：可靠 scope 模式下 S1–S7 同波运行，兄弟失败经 `Promise.allSettled` settle 后才传播；每阶段显示 attempt/耗时/blocked。
  - 验证命令/证据：`node --test scripts/lib/operating-analysis-stage-plan.test.mjs`（迁移后更新）；并行事件 trace；不执行真实生产流。

## P5：`operating_thesis`

- [ ] **P5-01 连接 S1–S5 的经营因果链**
  - 目标文件/模块：新增 operating thesis Prompt、manifest projection、runner/app stage registry。
  - 前置依赖：P3、P4-01、P2-03；S1–S5 的终态 schema 已冻结。
  - 完成定义：建立需求→量价→收入→利润率的可证伪链，记录支持/反面证据、替代解释、关键变量和失效条件；不新搜索、不生成估值。
  - 验证命令/证据：thesis fixture graph test；`npm run build:prompts`；Prompt 输入只含 compact financial trend + claim/evidence projection。

- [ ] **P5-02 更新章节 owner 与缺口回流**
  - 目标文件/模块：报告章节 projection、UI/API stage status、evidenceGap/requeue handling。
  - 前置依赖：P5-01。
  - 完成定义：S8 只补跨域判断，不重写 S1–S5；缺口可定向回流到对应事实域；不允许用 S8 新事实掩盖缺口。
  - 验证命令/证据：blocked/partial/requeue fixture；API/UI 状态断言；记录回流的最小阶段集合。

## P6：情景估值、确定性计算与最终结论

- [ ] **P6-01 建立 `scenario_valuation`**
  - 目标文件/模块：情景/估值输入 Prompt、JSON schema、runner/app registry、manifest graph。
  - 前置依赖：P5、P4-02、P4-03、P2-03。
  - 完成定义：S9 只读 S8 judgments、S6 financial observations、S7 market observations 和 S0；输出三情景、方法选择、DCF/反向/敏感性请求、风险传导和监测指标；不得输出未计算目标价。
  - 验证命令/证据：JSON schema/units/periods test；缺输入必须生成 `blockedValuationItems`；`npm run test:research`。

- [ ] **P6-02 迁移 deterministic valuation**
  - 目标文件/模块：`scripts/research-operating-analysis-runner.mjs` 中计算逻辑或新的 deterministic valuation module、valuation domain tests。
  - 前置依赖：P6-01；确认行业方法和单位/股本/净债务输入契约。
  - 完成定义：S10 只消费 S9 已确认输入；DCF、反向求解、敏感性、终值占比、EV→equity→per-share 和阻断 trace 可复算；模型不能写入计算结果。
  - 验证命令/证据：`node --test` valuation fixtures；边界/单位/金融行业不适用 fixture；保存 calculation trace。

- [ ] **P6-03 建立 `investment_conclusion`**
  - 目标文件/模块：估值结论 Prompt、stage registry、provenance projection、研究 API/read model。
  - 前置依赖：P6-01、P6-02、P2-03。
  - 完成定义：S11 只解释 S9/S10 和 source/claim manifest，覆盖估值隐含经营要求、反证、风险和监测；不新搜索、不改假设/数字、不重写章节2–8。
  - 验证命令/证据：Prompt contract test；无 deterministic result 时 blocked fixture；内联链接和 calculation ID 检查。

## P7：确定性组装、恢复迁移与真实本地验证

- [ ] **P7-01 实现 S12 确定性报告组装**
  - 目标文件/模块：`scripts/lib/operating-analysis-report.mjs`、`src/modules/research/application/research-operating-analysis.ts`、报告 API/read model、研究页面。
  - 前置依赖：P4、P5、P6；章节 owner matrix 已冻结。
  - 完成定义：完整十二章按设计映射组装；S1–S7 详细域正文直接进入对应章节；S11 不重写2–8；报告 projection 记录 run/artifact/source manifest 和门禁。
  - 验证命令/证据：`npm run test:investment-analysis`；章节、来源、状态和无重复改写 fixture；`npm run test:smoke:pages`（页面变更时）。

- [ ] **P7-02 实现恢复、定向重跑和旧 artifact 隔离**
  - 目标文件/模块：generic task/run/artifact protocol、runner recovery、migration scripts、旧六阶段 read/write 路径。
  - 前置依赖：P2、P3、P4、P5、P6；备份方案和精确数据范围已记录。
  - 完成定义：重启/lease 过期只重跑未终态及下游；完成 artifact 保留；来源/财务/市场变化按最小集合定向重跑；旧六阶段任务不与新 run 混写；不删除未授权数据。
  - 验证命令/证据：stale lease、interrupted run、sibling failure、downstream rerun fixture；`npm run test:research`；恢复日志和 artifact graph。

- [ ] **P7-03 本地真实任务和 API 终态验证**
  - 目标文件/模块：`./start-local.sh`、`scripts/local-job-worker.mjs`、研究 API、D1/SQLite read model、报告 projection。
  - 前置依赖：P7-01、P7-02；本地凭据、来源和 fixture 已准备；不触碰生产。
  - 完成定义：至少一次本地任务从 enqueue→claim→各波次→S10→S12 完成；API 读到终态、runId、artifact IDs、报告十二章和缺口；中断后从合法边界恢复有证据。
  - 验证命令/证据：`./start-local.sh`；`GET http://127.0.0.1:8000/api/health`；研究 refresh/read API；保存请求时间、task/run/artifact IDs、最终章节和状态。

- [ ] **P7-04 完成静态、类型和页面验收记录**
  - 目标文件/模块：全量新旧相关文件、docs、generated Prompt、web read model。
  - 前置依赖：P7-01、P7-02、P7-03。
  - 完成定义：无未解释 diff、无 stale generated Prompt、无旧 stage key 混用、无隐藏 partial/blocked；验证结果和跳过项写入交付记录。
  - 验证命令/证据：`git diff --check`；`npm run typecheck`；`npm run test:research`；`npm run test:investment-analysis-cli`；`npm run test:smoke:pages`（若页面改动）；按仓库当前约束补充 `npm run build:local`。任何失败都必须记录真实原因，不报告为干净成功。

## 延后事项与生产边界

- [ ] 生产 Cloudflare Worker、远端 D1 migration/apply、Worker deploy、生产任务重跑和生产数据清理：**不属于本批默认授权**，需单独变更请求、备份、精确范围、审批和生产健康/API/报告证明。
- [ ] 旧六阶段历史报告、旧 artifact 表和本地任务数据的清理：只有完成备份、范围确认和新协议本地重生成证明后，另行执行；不得以“新读模型可用”推断删除安全。
