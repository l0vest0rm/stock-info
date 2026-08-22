# stock-info 作为 taskd 调用方迁移 TODO

## 目标与边界

`taskd` 是**已提交至 taskd 的异步业务任务**的远端执行状态（排队、执行器租约、取消、
失败、最终结果）唯一事实源；它不是通用 LLM 调用层。
`stock-info` 只保留业务工作流、业务结果和可审计的业务版本；不得再维护通用
task/run/artifact 队列、租约或执行器协议。

计划纳入 taskd 的业务边界与 `client_task_name` 规则以
[taskd-business-task-naming.md](./taskd-business-task-naming.md) 为准；本文件只追踪迁移待办。

原本使用 `llm-client` 的同步调用继续使用 `llm-client`，不创建 taskd task、不定义
`client_task_name`，也不要求 taskd 的结果投影。本迁移只替换本地通用异步调度器中确实
需要远端任务生命周期的工作流。

调用方只使用业务语义 `client_task_name`，不生成或保存执行 ID。每次提交同一个
name 都由 taskd 创建一个新的、SQLite 自增的 `task_id`；只有最新提交可被执行器
claim。所有读取、取消和删除均按 `namespace + client_task_name` 进行。

同 name 的旧 queued task 会变为 `superseded`；旧 leased/running task 会变为
`interrupt_requested`。taskd 的 `task_id` 是执行器租约、heartbeat 和完成回调的内部
主键，不是 stock-info 的映射字段。

## 交付清单

| ID | 待办 | 完成定义 | 状态 |
| --- | --- | --- | --- |
| M01 | 增加 stock-info 的 taskd 调用客户端 | 仅在 `LLM_RUNTIME=local` 可提交、读取、取消和删除任务；调用方只传/使用业务 `name`，不保存 taskd ID。 | Complete |
| M02 | 建立业务结果投影协议 | taskd 成功结果可被同一业务 name 幂等投影；服务在投影前崩溃后可再次读取 taskd 结果恢复。公司报告发现与财务分析已接入；其余 taskd 业务待接入。 | In progress |
| M03 | 迁移公司报告发现 | 公司报告发现业务 name 直接用于 taskd；不再创建或读取泛化 LLM task/run/artifact。单篇研报预测与新闻研报提取继续直接使用 `llm-client`。 | In progress（待真实业务验证） |
| M04 | 迁移知识处理至直接 LLM 调用 | 删除知识处理对本地通用 claim/lease/run/artifact 的依赖；直接 LLM 调用只写当前知识结果与文档表，不提交 taskd 或保留运行账本。 | Complete |
| M05 | 删除 Web Search 证据包 | 删除本地 LLM 队列、接口、prompt、runner 和专属投影表；工程数据按各业务自身的 API/采集路径取得，不再维护通用 source package/evidence 表。 | Complete |
| M06 | 迁移财务与完整投资研究 | 财务分析与完整投资研究是 ChatGPT taskd 任务；stock-info 冻结工程输入并投影已校验的最终结果。旧普通经营分析删除。 | In progress |
| M07 | 删除本地通用执行运行时 | 删除 `/api/llm-tasks`、`local-job-protocol` 通用 claim/lease/run/artifact API、generic dispatcher/raw runner 和其调用入口。 | Complete |
| M08 | 删除泛化表及关联表 | 新迁移移除 `workflow_tasks`、`llm_runs`、`llm_run_artifacts`、`llm_task_dependencies`、`llm_workflow_artifact_links`、`llm_run_artifact_links` 和专属序列记录；不改已应用迁移。 | Complete |
| M09 | 明确实时输出替代 | taskd 当前只提供最终 `result` 与覆盖式 `checkpoint`；stock-info 仅展示阶段/状态，不再保存或恢复模型文本增量。 | Pending |
| M10 | 扩展 taskd 执行能力 | input-gateway 对 stock-info 所需的 task type 有明确能力；纯工程任务不进入 taskd。 | Pending |
| M11 | 统一验证 | 类型检查、目标测试、SQLite 全量迁移、`start-local.sh` 健康检查与 taskd/input-gateway 实际提交-执行-投影链路均通过。 | Pending |

## 业务归属

| 业务 | 是否使用 taskd | `client_task_name` / 结果位置 |
| --- | --- | --- |
| 公司报告发现 | 是 | `company:report-discovery:{securityCode}`；公司报告 source pool |
| 单篇研报预测提取 | 否，直接 `llm-client` | 无 task name；报告预测缓存 |
| 新闻研报提取 | 否，直接 `llm-client` | 无 task name；新闻研报缓存 |
| 知识处理 | 否，直接 `llm-client` | 无 task name；当前知识结果与文档表 |
| Web Search 证据包 | 否，已删除 | 无 task name；不保留专属表 |
| 普通经营分析 | 否，已删除 | 无 task name |
| 完整投资研究（原低依赖经营分析） | 是 | `research:investment-analysis:{securityCode}`；投资研究业务成果表 |
| 财务分析 | 是 | `research:financial-analysis:{securityCode}`；财务分析业务成果表 |

## 已落地的 name 与投影

| 业务 | name | 幂等业务投影 |
| --- | --- | --- |
| 公司报告发现 | `company:report-discovery:{securityCode}` | 覆盖写 `app_kv` 的公司报告 source pool；重读 taskd 成功结果会再次执行同一投影。 |
| 财务分析 | 当前包含 `inputFingerprint` 与 `promptVersion`，待收敛为 `research:financial-analysis:{securityCode}` | `research_financial_analysis_results`；校验 8 个编号 H1 与至少 800 字后 upsert。 |

## 尚未纳入原清单的调用方

以下调用方应继续或恢复为直接 `llm-client` 调用；它们不进入 taskd。删除本地通用表前，
需要把其对 `generic_raw_model` 的调度依赖移除，但不需要补 taskd name 或 taskd 投影：

- `forecast-synthesis.ts`
- `research-auto-filing-insights.ts`
- `research-industry-source-series.ts`
- `information-processing.ts`

其中知识处理还需要保留其既有业务结果写入与失败清理语义；M02 只适用于真正的 taskd 业务。

## 实施约束

- taskd 的 `task_id` 仅供 taskd/执行器内部使用，stock-info 不持久化它。
- 重复提交相同 `client_task_name` 即代表新的业务输入；taskd 自动替代该 name 的旧任务，不需要调用方生成 run/generation ID。
- task name 只由稳定业务身份组成；不得含 task ID、UUID、时间戳、attempt、输入 hash、prompt version、模型或 reasoning effort。版本和输入快照放 taskd `input` 与业务结果表。
- 直接 `llm-client` 调用没有 task name，且不通过 taskd 查询、取消或投影。
- 业务表中可缓存远端状态用于列表展示，但不得据此实现 claim、lease、executor heartbeat 或本地重试调度。
- 任务完成后由读取路径或业务协调器调用同一个幂等投影函数；投影成功后才标记业务成果可用。
- 现有 taskd 不提供文本增量事件。本次不得以保留 `llm_run_artifacts` 的方式绕过该缺口。
- `task_id` 是 taskd SQLite 的自增主键（rowid），只供执行器 lease/start/heartbeat/complete 使用；调用方 API 不按该字段寻址。

## 本地任务状态缓存与查询规则

调用方必须先读本地 `kv_cache` 中的业务任务快照，再决定是否访问 taskd。默认路径应是“本地缓存优先”，
而不是“页面每次读取都去 taskd 查询一次”。

- 从未提交过任务时，本地应表现为“无任务”，不要为了确认不存在而访问 taskd。
- 已有稳态结果时，本地直接返回缓存的 `task`/`report` 快照；稳态包括 `completed`、`failed`、`blocked`，以及本地根本没有 task 记录的场景。
- 只有中间态才需要向 taskd 对账；中间态仅指本地缓存中的 `queued`、`running`，或其他明确表示“远端执行仍可能推进”的状态。
- 对账成功后，把最新 `task` 状态和已投影的业务结果回写到本地 `kv_cache`；后续页面读取继续先读本地快照。
- 读取 taskd 的目的，是推进本地中间态到新的可解释状态；不是把 taskd 当成每次页面初始化的默认查询源。

推荐的本地缓存结构如下，既保存业务结果，也保存最近一次 taskd 任务状态：

```json
{
  "report": {
    "...": "..."
  },
  "task": {
    "status": "running",
    "name": "research:investment-analysis:603986.SH",
    "createdAt": 1786517056000,
    "updatedAt": 1786529418000,
    "completedAt": null,
    "errorMessage": null
  }
}
```

约束如下：

- `report` 保存已物化、可直接被页面或业务读取的最终业务结果；没有结果时可为 `null` 或缺省。
- `task` 保存最近一次已提交到 taskd 的业务任务快照；从未提交过时应为 `null` 或缺省，而不是触发一次“探测式”远端查询。
- `status` 的解释以本地业务快照为准；只有本地已知中间态时，才允许调用方再去 taskd 拉新状态。
- `completedAt` 为空表示任务尚未完成；完成后应写入时间戳，并配合 `report` 一起形成可复用的稳态快照。
