# 投资分析 LLM 任务统一设计

状态：设计稿，尚未改变运行时代码、测试或迁移。

本文只记录目前从仓库代码、配置和迁移中可以核实的边界，以及统一任务协议的目标设计。以下“当前”是静态代码/架构核对结论，不等同于本次对真实模型、长连接或生产 Worker 的运行时证明。

## 1. 目标与非目标

### 1.1 目标

1. 为投资分析、Web Search 信息包和后续同类 LLM 工作建立一个统一的持久任务协议：任务可入队、认领、续租、重入队，并在刷新或 Node 进程重启后仍能读到状态。
2. 明确三层边界：LLM 请求缓存只做请求优化；通用任务/运行账本负责执行生命周期；业务投影负责可查询、可审计、可复用的研究结果。
3. 取消 investment-analysis 在模型流式输出期间按时间/字符周期写入 `partial` 正文；以阶段终态和最终报告终态作为恢复、UI 和下游查询的依据。
4. 保留终态输出、失败原因、尝试和任务账本，避免一次 Node 中断使任务状态不可解释，也避免把不完整正文误当成完成报告。
5. 复用现有 `forecast_consensus` 的采集包路由，但保持它是“外部预测补充”，不把它提升为内部研报预测账本或市场共识。

### 1.2 非目标

- 不把 `llm_cache_entries`、`app_kv` 中的分析缓存或浏览器缓存改造成预测、事实或共识数据库。
- 不让生产 Worker 调用远端 LLM；不改变 `LLM_RUNTIME=local` 可调用、`LLM_RUNTIME=production` 只读的边界。
- 不用 Web Search 替换已有结构化行情、三表、证券主数据、13F 或宏观序列，也不增加 K 线的备用数据源。
- 不在本设计中修改 prompt、模型、Web Search 来源授权、财务来源路由或业务计算公式。
- 不因为一个 LLM 任务有输出文本就自动生成事实、预测、情景、估值或用户决定；缺证据、冲突和不可比仍须显式阻断。
- 不把旧表、旧 API 返回形状或已有历史记录兼容作为目标；切换可以直接采用新协议。切换前完成备份并确认范围后，可清空/重建受影响的本地研究任务、运行记录、阶段产物和旧 `partial_output`，再按新模型重新生成。

## 2. 当前已核实的职责边界

### 2.1 LLM cache：请求去重/过期复用，不是业务读模型

目前的 `llm_cache_entries`（`migrations/0007_llm_cache_entries.sql`）只有 `cache_key`、provider、model、`request_json`、`response_json` 和 `expires_at`。共享客户端根据 provider、model、instructions、input、工具和请求选项生成哈希键，并仅按键和过期时间读取；过期后记录即可失效。`requestLlmText()` 可传入 `cacheEnabled`，而 investment-analysis runner 的每个阶段明确使用 `cacheEnabled: false`。

因此该缓存的职责是：

- 在相同请求身份下减少重复的 provider 调用或合并并发请求；
- 保存一份 provider 返回载荷，按 TTL 复用；
- 不能表达任务目标、证券/公司主体、报告期、币种、单位、来源链接、证据摘录、口径校验、纳入/排除理由或版本替代关系；
- 不能表达 `queued/running/completed/failed`、租约、尝试、阶段依赖、失败恢复或业务投影是否已物化；
- 不能保证返回内容已通过 JSON/Markdown 结构门禁、来源回链、数值和可比性校验；
- 不能作为历史账本：同一业务对象的再运行、prompt 版本和输入变化应产生新的运行记录，而不是覆盖或依赖一条会过期的缓存项。

公司报告/预测的 `app_kv` 或共享报告分析缓存同样是按报告身份和 TTL 复用的提取结果。它们不作为新协议的历史导入来源或业务主源；业务查询必须读取来源预测、信息证据、Web Search 证据包、阶段终态和报告运行历史等持久投影。切换时可清理缓存并重新生成受影响结果，缓存丢失、过期或被禁用不应让新协议已经物化的业务结果变成缓存文本。

### 2.2 partial：当前是流中间态，不是事实或可恢复的业务快照

静态代码核实到 investment-analysis 当前为六阶段任务（公司事实基线、行业验证、经营分析、财务分析、估值输入、估值结论）。非 Web Search 的 Markdown 阶段通过 `onText` 聚合正文；runner 按配置的 `intervalMs=1500`、`minChars=800` 周期调用 checkpoint endpoint，把正文写入阶段表的 `partial_output`。阶段结束时还会强制写一次 checkpoint，随后终态写入 `output_json` 或 `output_markdown` 并清空 `partial_output`。需要 Web Search 的阶段没有同样的 `onText` checkpoint。

页面在任务为 `running` 时读取当前阶段的 `partialOutput` 并展示“已保存正文”；这是进度展示，不是报告完成证明。阶段写入由 attempt、lease owner 和任务租约围栏，过期/错误 attempt 的迟到写入会被拒绝。Node 运行时中断后，只有租约过期才会把运行中的阶段重新置为 `queued`；已完成阶段作为后续阶段的输入保留，重新开始阶段时会清掉旧的 partial 文本。

`partial` 有两种不能混用的含义：

1. `partial_output`：流式期间的周期性中间文本，可能在任意 token 边界截断，当前不具备业务终态语义；
2. 阶段状态 `partial`：阶段请求已经返回并写入一个终态输出，但输出本身明确标记为部分完成/受限。它必须带原因，不能被 UI 或下游当作完整阶段。

### 2.3 终态：阶段终态、任务终态和报告运行历史各自负责什么

- 阶段表允许 `complete`、`partial`、`blocked`、`not_applicable` 等终态；`failed` 由任务失败路径标记。阶段终态保存输出、阻断信息、开始/完成时间和 attempt。
- 任务表使用 `queued`、`running`、`completed`、`failed`。完成任务前，当前实现要求组装后的报告包含固定的 11 个章节；缺章节、空报告、缺 prompt 或缺输入指纹都会拒绝写入最终 run。
- `research_operating_analysis_runs` 是追加的运行历史，保存 `runId`、prompt/input、模型/provider、生成时间、耗时、报告正文、reasoning 和紧凑 stream 统计；不能把它解释为请求缓存。
- 阶段终态不是最终报告终态：某个阶段 `partial` 或 `blocked` 时，整项任务不能伪装成 `completed`。业务投影只有在相应结构和证据门禁通过后才可被查询为可用。

### 2.4 queue：执行生命周期、租约和并发占用

当前 investment-analysis 及 Web Search 包均采用持久任务：页面/CLI 只入队，Node runner 在后台认领；页面刷新、切换 Tab 或关闭不会取消已经创建的任务。Web Search 包使用 `security_code + package_kind + prompt_version` 作为持久身份；investment-analysis 使用 `security_code + prompt_version`，重复点击在相同身份下去重，失败任务可显式重新入队。

通用本地任务协议（`migrations/0105_local_job_protocol.sql` 及 `src/shared/local-job-protocol.ts`）提供：

- `queued → running → completed|failed` 的任务生命周期；
- `attempt`、`lease_owner`、`lease_until`、heartbeat 组成的 fencing token，只有当前认领者可以写入终态；
- 过期租约重入队，以及共享 provider 占用账本，防止多个 Node handler 超过统一并发上限；
- 任务的错误、尝试、开始/完成/更新时间，供 API/UI 读取。

queue 只回答“是否执行、谁在执行、执行到哪一个可恢复边界、最后为何失败”，不回答“该正文是否是公司事实、该预测是否同口径或该证据是否可纳入汇总”。这些必须由业务投影和确定性校验回答。

## 3. 决策：取消周期 partial checkpoint，保留终态与任务账本

### 3.1 推荐行为

investment-analysis 的流式阶段改为：

1. `start` 时记录任务、阶段输入和 prompt 快照；
2. 模型流期间只在 runner 内存中累积文本，不按时间或字符周期写 `partial_output`；
3. provider 返回后先完成格式/结构校验，再一次性写阶段终态（`complete`、`partial`、`blocked` 或 `not_applicable`）及其输出；
4. 全部依赖阶段达到允许的终态后，确定性组装报告，满足固定章节和其他完成门禁才写入报告 run，并把任务置为 `completed`；否则写入可解释的 `failed`/阻断状态；
5. runner 中断时按阶段边界恢复：已写入的阶段终态保留，当前未写入终态的阶段重新执行。不得把内存中最后一段正文推断为业务结果。

取消周期 checkpoint 的理由是减少高频 D1 写入、避免截断文本被误读为事实、缩短“看似有正文但无法完成”的状态歧义，并使恢复边界与实际可复用的阶段产物一致。这里的“取消”只针对流中间态写入；不取消 heartbeat、租约续期、任务状态变更或终态审计。

### 3.2 必须保留的对象

- 任务账本：任务身份、去重键、状态、attempt、租约、模型/effort、prompt 版本、输入指纹、错误和时间戳；
- 阶段终态：阶段 key、终态、结构化/Markdown 输出、阻断项、来源/上游 artifact 引用和完成时间；
- 报告终态与新运行记录：切换后每次成功运行独立 `runId`，保留完整输入、prompt、模型/effort、报告正文和生成元数据；切换前的旧运行记录不构成兼容要求，可在备份并确认后清空并重新生成；
- 失败和重入队记录：不覆盖旧错误，不把失败任务显示成空成功；
- provider terminal metadata（若客户端可提供）：用于确认 provider 已结束，不能只以 HTTP 200 或非空文本代替。

### 3.3 UI 语义

取消 checkpoint 后，`running` 页面只展示任务状态、当前阶段、已完成阶段、尝试/耗时和连接告警，不再声称“以下是已保存的当前正文”。切换后新协议已完成的报告可按 `runId` 查看；切换时旧报告可按清理范围删除。新的正文只有在阶段终态和报告完成门禁通过后替换为活动结果。`partial` 必须显示为“部分完成/需补充”，不能显示为“已完成”。

## 4. 目标通用任务协议：Generic LLM Run + business projection

推荐采用“两账本一投影”边界，而不是让业务表兼任队列或让缓存兼任事实库：

```text
Generic task ledger
  └─ LLM run/attempt ledger
       └─ terminal artifacts (per stage/step, no periodic partial body)
            └─ business projection (validated, queryable, source-bound)
```

### 4.1 Generic task/run 层（协议所有权）

可新增独立表，也可以以等价的统一视图落地；切换后读写只走新协议，不导入旧行或保留旧形状适配；推荐字段如下：

| 对象 | 必须字段 | 所有权与约束 |
| --- | --- | --- |
| `llm_tasks` | `task_id`、`task_type`、业务目标类型/ID、`idempotency_key`、`protocol_version`、`prompt_version`、`status`、创建/更新时间 | 队列身份和去重；不放业务事实正文 |
| `llm_runs` | `run_id`、`task_id`、`attempt`、provider/model/effort、输入指纹与 `input_as_of`、prompt 快照、lease/heartbeat、开始/完成时间、终态、错误码/信息 | 每次 provider 执行一行；追加历史；attempt/lease 围栏写入 |
| `llm_run_artifacts` | `run_id`、`step_key`、上游 artifact IDs、输出类型、终态、输出 JSON/Markdown、结构校验状态、阻断/错误、完成时间 | 只保留终态阶段产物；中间 token 不入库；输出不能自动成为事实 |

Generic 层负责入队、去重、claim、lease、heartbeat、重试/重入队、终态和可观测元数据；不负责判断公司主体、会计口径、来源独立性、市场边界、预测汇总或估值公式。

### 4.2 Business projection 层（业务所有权）

每个业务类型保留自己的可查询投影和校验规则：

- investment-analysis：阶段终态经过组装和章节门禁后投影为 `research_operating_analysis_runs`；切换后新报告按 `runId` 记录，当前页面只选定某个 `runId`，切换前旧报告可在清理范围内删除。
- Web Search 信息包：终态 JSON 解析为 `research_web_search_source_packages` 与 `research_web_search_evidence_records`；每条证据保留主体、字段、期间、单位/币种、来源 URL、引用状态、缺口和冲突。
- 研报预测：继续走信息记录 → 来源审核 → `research_source_forecasts` → 确定性汇总快照；模型整理稿不是来源事实。

Projection 只能引用 Generic run/artifact 的 ID 和输入版本，不能反向修改执行账本。业务查询只读 projection；需要刷新时创建新 task/run，而不是直接改写旧 projection。

### 4.3 为什么不把 Generic run 当业务表

同一个 `run_id` 只能证明某次模型执行及其输出边界，不能证明输出中的数值真实、同口径或被授权。业务投影必须在落库前执行主体、期间、单位、币种、会计/EPS 口径、来源回链、JSON schema、结构章节和确定性计算门禁。没有投影时，API 返回 `unavailable`/`blocked`/`pending`，不以空数组、零或缓存文本替代。

## 5. `forecast_consensus` 的复用方式

现有配置将 `forecast_consensus` 定义为 `research-web-search.forecast-external-supplement.v3`，标签为“外部预测补充包”，只负责在内部预测账本缺少所需前瞻材料时搜索公开、可回链的行业或公司预测。准备 prompt 时会读取 `research_source_forecasts` 的覆盖摘要；prompt 明确要求不搜索或重建内部已有研报，也不把结果拼成“市场一致预期”。

统一后应复用 Generic task/run 的以下能力：

1. 页面点击创建一个具有 `security_code + package_kind + prompt_version` 身份的 task；相同身份只复用任务状态/已物化包，模板变更或用户扩大范围才建立新版本。
2. runner 认领、租约、attempt、heartbeat、provider 并发和终态错误统一处理；不为该包另造一套队列。
3. provider 返回后将 JSON 和引用写入 Web Search 业务投影；任务终态只表示执行完成，不表示每条证据都已验证。
4. 内部研报预测仍由来源预测账本和审核/标准化流程提供；外部补充包的记录默认保持“外部前瞻事实”，不得直接写入 `research_source_forecasts` 或汇总快照。若以后要纳入研报预测样本，必须经过来源身份、独立性、期间、币种/单位和会计口径审核，形成新的不可变来源预测版本。
5. UI 同时显示“内部账本覆盖摘要”“外部补充包状态”“已验证/未回链/不可得/冲突条数”，并固定标注“非市场一致预期”。

这样复用的是任务执行协议和引用链，不是把外部搜索结果与内部研报样本混为一个事实源。

## 6. 持久化模型与 API/UI 状态

### 6.1 建议的持久化映射

切换时直接建立以下目标职责；不设计旧数据读取、历史导入或双写。实现可以复用表名，但必须按新协议重置受影响的本地数据和状态。

| 目标对象（可替换现有对象） | 统一协议中的角色 | 切换原则 |
| --- | --- | --- |
| `llm_tasks` | task ledger | 以新协议的身份键、状态和租约字段为准；不导入旧 job 行 |
| `llm_runs` | LLM run/attempt ledger | 每次新执行写入一行；不读取或转换旧 run 历史 |
| `llm_run_artifacts` | terminal artifact projection | 只写阶段终态和阻断项；不导入旧 `partial_output` |
| `research_operating_analysis_runs` | investment-analysis business projection + new run history | 按新 `runId` 重新物化；旧报告可在备份并确认后清空 |
| `research_web_search_source_packages`、`research_web_search_evidence_records` | Web Search business projection | 新任务完成后重新生成引用、缺口、冲突和证据状态 |
| `research_source_forecasts`、consolidation snapshot | forecast business ledger | 不由通用 Generic run 直接写入；只接收通过审核的来源版本 |
| `llm_cache_entries` | provider request cache | 继续按 TTL/请求哈希使用或禁用；业务 API 不读取它作为主源 |

### 6.2 API 状态契约

- `POST .../refresh`、Web Search package enqueue 和 CLI：只创建/复用 task，返回 `taskId`、去重结果和当前状态，不等待模型完成。
- `GET` 任务读模型：返回 task 状态、当前 attempt/lease 的可安全元数据、阶段终态摘要、错误/阻断、已物化 projection ID 和本次 run/artifact 版本；不从 cache 表拼正文。
- 状态语义：`queued`（已入队）、`running`（有活动 attempt）、`completed`（projection 和终态门禁均通过）、`failed`（执行/校验失败，可重试）、`blocked`（业务门禁阻断；可作为阶段终态或任务读模型原因）。`partial` 只允许出现在明确的阶段/证据终态，必须带原因和影响范围。
- 任何非终态正文都不应让 API 返回 `completed`。HTTP 200、非空文本或 provider 的单个中间事件都不是完成证明。

### 6.3 页面状态

页面只轮询 Generic task/read model；刷新、切换 Tab、关闭页面不取消后台任务。运行中显示阶段和状态，不显示未落库的 token；完成后读取指定 `runId`/`packageId`；失败显示错误与重新入队动作；`partial/blocked/unavailable` 显示边界和下一步，不用空值伪装成功。

## 7. 分阶段切换、清理与安全回滚

切换以新协议为唯一运行时和读模型，不设置 legacy adapter、旧数据导入、旧 API 形状适配或双写路径。历史数据不是切换目标：对受影响的本地研究任务、运行记录、阶段产物、Web Search 包和旧 `partial_output`，在备份并明确确认后可以清空/重建；切换后只按新模型重新生成。

### 阶段 0：冻结契约、盘点范围和备份

- 建立 task type、状态、idempotency key、terminal gate 和 projection owner 清单。
- 只读核对现有 task/run/stage/package 表的字段、消费者和 API，用于确定新模型的目标职责和清理范围；不建立旧数据读取路径。
- 在任何清空、重建或破坏性 D1 操作前，导出受影响表的可恢复备份，列出精确表/行范围并取得明确确认；备份是安全措施，不是历史兼容要求。

### 阶段 1：Generic 任务账本

- 新增 Generic task/run/artifact 的最小 schema 或等价目标表；切换后 writer 只写新表，不导入旧 queue 行。
- 清空并重建受影响的本地 task/run/stage 数据后，统一 claim/lease/attempt/provider slot 的读模型。
- 验证重复点击、租约过期、并发认领和刷新读状态；不把 LLM cache 迁入 Generic 业务表。

### 阶段 2：先切换 Web Search 与 `forecast_consensus`

- 让现有六类 package 共用 Generic task 生命周期，按新协议重新生成 source package/evidence projection。
- endpoint 和 UI 直接切到 Generic read model 及新的 package 形状；不保留旧 `job`/`package` 响应适配或导入旧包。
- 明确内部预测账本覆盖摘要和外部补充的非共识文案，做新版本/重复点击回归。

### 阶段 3：切换 investment-analysis 并取消周期 checkpoint

- runner 停止调用 checkpoint endpoint；保留 `start`、阶段终态、任务 heartbeat/lease 和最终报告完成接口。
- 清除受影响任务的旧阶段产物和 `partial_output`，从新协议的空任务边界逐阶段重新执行；只有新写入的阶段终态才可作为后续恢复边界，内存中的截断正文不作为 projection 输入。
- 所有页面、CLI、比较页直接读取新终态/任务读模型；不双写旧 stage/run，也不保留旧 partial 读路径。

### 阶段 4：收敛与清理

- 删除不再需要的旧队列表、旧 `partial_output` 列、旧 endpoint 分支和迁移映射；不保留只为历史兼容的读路径。
- 对清理后的本地数据按新模型完成一次完整重生成和读写验收；清理/重建属于本设计允许的破坏性操作，但必须遵守阶段 0 的备份与确认边界。

### 发布与数据库安全边界

- 代码发布仍保留标准的回滚能力：发现新版本缺陷时回退到已知可用的代码/Worker 发布版本；这是发布操作，不等于恢复旧 API 形状或把旧数据重新接入新读模型。
- 数据库清空、重建、列删除和迁移必须先完成可恢复备份、精确范围核对和明确确认；需要事故恢复时可从备份恢复，但恢复后的数据仍须按选定的新代码重新生成，不把备份恢复设计成日常兼容路径。
- 切换后禁止新旧 writer 混跑或混写 attempt；若代码回滚涉及 schema 不兼容，先停止写入并按备份/发布流程处理，不让迟到输出越过 fencing token。
- 任何迁移失败、未回链或部分投影均须在 API/UI 显示，不报告为干净成功。

## 8. 验收标准与不做项

### 8.1 验收标准

1. 相同业务目标和 prompt 版本的重复点击只产生一个活动 task；不同版本产生可追溯的新 task/run。
2. 任务在刷新、页面关闭、Node 重启和租约过期后仍能读到 `queued/running/failed/completed`，迟到 attempt 无法写入新终态。
3. investment-analysis 流期间不再按时间/字符更新 `partial_output`；只有阶段终态和最终报告一次性写入。中断后从最近终态阶段恢复，不能把截断正文标为完成。
4. 报告只有在固定章节、输入指纹、prompt 快照、provider terminal signal（可用时）及业务校验通过后才显示 `completed`；非空文本或 HTTP 200 单独不足以完成。
5. Web Search 证据包保留来源 URL、标题、日期、期间、单位/币种、引用状态、缺口和冲突；单条未回链记录不能标为已验证。
6. `forecast_consensus` 明确复用内部覆盖摘要，既不重复搜索已有研报预测，也不进入内部预测汇总或冒充市场共识；若要纳入必须经过独立审核和新版本账本。
7. 业务 API 在 LLM cache 过期、禁用或被清理后仍能读取已经物化的 run/package/forecast projection；API 不直接查询 `llm_cache_entries` 作为业务主源。
8. 本地允许 `LLM_RUNTIME=local` 由 Node runner 发起远端调用；生产保持 `LLM_RUNTIME=production`，LLM 写入和草稿生成端点不可用，只读已物化结果。
9. 切换前对受影响本地数据完成备份并明确确认；切换时可清空旧 task/run/stage/package 记录和 `partial_output`，随后按新协议成功重新生成任务、阶段终态、报告和证据包；验收不依赖旧历史可读。
10. 代码发布可回退到已知可用版本；任何数据库破坏性操作都有可恢复备份、精确范围和确认记录，且不以恢复旧数据形态作为兼容目标。

### 8.2 明确不做

- 不恢复“每个 token/固定间隔都持久化正文”的方案；不以提高轮询频率替代终态协议。
- 不为流失败增加无证据的重试、备用 provider 或生产 LLM fallback；重试必须由任务 attempt/租约和明确错误类型驱动。
- 不把 `partial`、`uncited`、`unavailable`、`blocked` 映射成零、空成功或中性结论。
- 不把机会性外部预测样本命名为完整市场一致预期，不把模型整理稿当来源事实。
- 不在本地验证成功后宣称 Cloudflare 生产链路已经验证；生产部署、远端 D1 和真实 API 仍需独立证明。

### 8.3 风险与安全边界

- 清空/重建会丢失受影响本地任务、运行记录、阶段产物和旧 `partial_output`；通过备份、精确范围和明确确认控制风险，不能把未备份的删除报告为安全完成。
- 新协议需要重新调用 provider，可能受到耗时、配额、来源可得性和结构校验失败影响；验收必须覆盖 `queued/running/failed/blocked/completed` 及可解释的重入队，而不是用旧文本填充结果。
- 发布回滚和数据库恢复是两条独立的事故处置路径：代码可回退，数据操作可从备份恢复；两者都不恢复旧兼容读写或双写方案。schema 不匹配时先停止写入并按安全流程协调版本。
- 本地重建成功不证明真实 provider SSE、Cloudflare Worker 或远端 D1 已验证；生产边界仍按第 9 节单独证明。

## 9. 本地/生产边界

本地标准路径仍是 `./start-local.sh`：Node runtime 负责 runner、队列认领和允许的远端 LLM 调用；页面/API 读取本地 D1 中的任务与业务投影。设计验收可在本地检查入队、刷新、租约恢复、终态投影和 UI 状态，但这不等同于真实 provider SSE 或生产证明。

生产是 Cloudflare Worker + 远端 D1 的只读边界：`LLM_RUNTIME=production`，不运行本地长驻 runner，不从生产页面触发 LLM 写入或草稿生成。生产只读取已经通过本地处理、确定性校验和部署流程物化的 projection。任何需要生产写入、远端迁移、部署或真实生产 API 验证的工作必须单独执行并记录证据；本设计不把本地任务完成状态解释成生产完成状态。
