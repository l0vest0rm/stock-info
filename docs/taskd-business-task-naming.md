# stock-info 的 taskd 业务范围与任务 name 规范

## 结论

`taskd` 只承接需要**异步、可取消、可由分布式 input-gateway 执行器执行**的业务模型任务。
它不是 stock-info 的通用 LLM 客户端，也不取代业务表、业务工作流或确定性计算。

在 taskd 中，`name` 表示“同一个逻辑业务操作中，只应保留最新一次提交”的范围；它不表示某
一次执行、某份输入快照或某个 Prompt 版本。调用方以 `namespace + name` 提交、查询、取消和
读取结果，不保存 taskd 的内部 `task_id`。

同一个 `name` 再次提交时，taskd 创建新的内部任务，并使较早的同名 queued 任务
`superseded`、已领取/运行的任务 `cancel_requested`。因此，只有把会替代旧结果的请求放在
同一个 name 下，才能得到“只处理最新提交”的语义。

## 通用命名规则

格式：

```text
{domain}:{operation}:{stable-business-key}[:{stable-subtype}]
```

| 组成 | 规则 | 示例 |
| --- | --- | --- |
| `domain` | 稳定业务域，小写 kebab-case。 | `company`、`research` |
| `operation` | 用户能理解的业务动作，不使用执行器/模型术语。 | `report-discovery`、`financial-analysis` |
| `stable-business-key` | 在该业务域内稳定标识目标对象；证券任务使用规范化 `securityCode`。 | `300308.SZ` |
| `stable-subtype` | 仅在同一对象下可独立替代、独立领取的稳定子工作单元存在时添加。 | `forecast_consensus`、`stage:financial_analysis` |

`name` **不得**包含 task ID、UUID、时间戳、attempt、lease generation、输入指纹/hash、
数据截点、Prompt/协议版本、模型或 reasoning effort。这些信息必须保存在 taskd `input` 和
业务结果投影中。把它们拼进 name 会让新提交不能替代旧任务，违背 latest-only 语义。

对 `securityCode` 先使用 stock-info 的统一规范化代码（例如 `300308.SZ`）；不得用名称、
展示 ticker 或未经标准化的用户输入构造 name。

## 为什么某项业务需要 taskd

不是“调用了大模型”或“执行时间长”就应使用 taskd。只有业务确实需要下列远端任务服务
能力时才提交 taskd：

| 需要的能力 | taskd 提供的价值 | stock-info 不再需要承担的职责 |
| --- | --- | --- |
| 请求与执行解耦 | API 可立即返回；input-gateway 在稍后从任一可用执行器领取任务。 | 在 Web/API 进程中持有长连接、等待模型完成。 |
| 分布式执行器路由 | 按任务类型由已注册能力的 input-gateway 执行；执行器可以横向增加或重启后重新注册。 | 固定一个本地 runner、自己选择或恢复执行器。 |
| 服务端持久状态 | taskd 保存排队、租约、取消、失败和最终结果；调用方按业务 name 重读。 | 自建泛化 task/run/lease/heartbeat 账本。 |
| 最新提交优先 | 同一业务 name 的新请求自动淘汰未执行旧请求，并请求取消正在执行的旧请求。 | 自行比较输入版本、手动取消旧 job。 |
| 调用方无执行映射 | stock-info 始终用业务 name 查询/取消/取结果，不保存 taskd `task_id`。 | 保存业务 ID 到远端任务 ID 的映射并处理重启恢复。 |

反过来，若调用只是当前请求链路内的直接 `llm-client` 调用，调用方已能同步处理成功/失败并
写入自己的业务结果，且不需要跨执行器领取、latest-only 取消或远端任务恢复，则不使用
taskd。taskd 也不负责 stock-info 的业务编排、输入构造、结果质量校验、结果投影和确定性
计算；这些仍由 stock-info 持有。

## 计划使用 taskd 的业务

| 业务工作流 | 必须借助 taskd 的具体原因 | 提交到 taskd 的边界 | name 规则 | 当前状态 |
| --- | --- | --- | --- | --- |
| 公司报告发现 | 发现过程由 input-gateway 的远端浏览器/ChatGPT 能力执行，调用端不应等待；用户再次触发发现时，只应保留该证券最新的一次请求。taskd 提供执行器领取、持久状态、取消和 latest-only 替代。 | 整个“发现公司报告 source pool”的模型工作。 | `company:report-discovery:{securityCode}` | 已开始迁移；现有 name 尚未收敛。 |
| 财务分析 | 完整分析由远端执行器运行且结果产生后需再做业务质量校验；刷新分析时旧执行没有价值。taskd 把长执行、取消、重启后的状态/结果读取交给服务，stock-info 只构造输入并投影通过校验的最终结果。 | 整个财务分析模型任务；数据快照和 Prompt 放在 input/投影。 | `research:financial-analysis:{securityCode}` | 已开始迁移；现有 name 尚含版本/指纹，待收敛。 |
| 完整投资研究（原低依赖经营分析） | stock-info 先工程化采集证券和财务必要输入，ChatGPT 负责公开信息核验、行业/竞争/风险判断和报告生成；刷新时旧报告请求必须被新请求替代。taskd 只承接这一份 ChatGPT 分析任务。 | 一份完整的投资研究 Markdown 报告。 | `research:investment-analysis:{securityCode}` | 已开始迁移。 |

### 完整投资研究

旧“普通经营分析”六阶段和原低依赖父子 work package 都不再是 taskd 任务模型。当前页面
只提交一份完整研究：

```text
research:investment-analysis:300308.SZ
```

证券、财务数据和数据来源由 stock-info 工程侧采集后冻结到 taskd `input`；ChatGPT 只负责
基于该输入和公开资料进行分析与生成。以后只有确实重新出现可独立替代的 ChatGPT 子任务时，
才增加稳定 `:stage:` 或 `:package:` 后缀。

## 明确不使用 taskd 的业务

以下路径继续直接调用 `llm-client`。它们没有 taskd name，也不通过 taskd 查询、取消或
投影：

| 业务 | 直接调用/结果归属 |
| --- | --- |
| 单篇研报预测提取 | 报告预测缓存 |
| 新闻研报提取 | 新闻研报缓存 |
| 知识文档处理 | `knowledge_processing_runs` 与知识文档表 |
| `forecast-synthesis.ts` | 既有直接 LLM 结果 |
| `research-auto-filing-insights.ts` | 既有直接 LLM 结果 |
| `research-industry-source-series.ts` | 既有直接 LLM 结果 |

这些路径在删除本地通用调度账本时，需要改为直接调用并保留各自的业务写入/失败语义；这不
意味着应把它们接入 taskd。

## 当前实现与目标的差异

| 业务 | 当前 name | 目标 name |
| --- | --- | --- |
| 公司报告发现 | `company-report-discovery:{securityCode}:company-report-discovery.v5` | `company:report-discovery:{securityCode}` |
| 财务分析 | 含 `inputFingerprint` 和 `promptVersion` | `research:financial-analysis:{securityCode}` |
| 完整投资研究 | 原低依赖工作流使用本地通用调度与 work package | `research:investment-analysis:{securityCode}` |

迁移状态和删除本地通用调度表的前置条件见
[taskd-caller-migration-todo.md](./taskd-caller-migration-todo.md)。
