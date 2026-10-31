# 本机网页研究执行

## 边界

Rust 业务入口 → 本地执行账本 → `cea-sdk` workflow → 已登录的 CEA Profile
→ SDK 完成凭据/来源提取 → 原有业务校验器 → 原有报告存储 → API/页面。
没有 taskd HTTP、CEA CLI 子进程、Node 后端或自动发布。
直接 API 模型仍由 `config/app/llm.json` 管理，不随网页模型切换。

## 数据库变动

**不增加表，不增加迁移，不迁移或清理用户数据。** 在现有 `kv_cache` 中新增两个
durable namespace，`expires_at` 为 NULL，不可当普通缓存清除：

| namespace | key | 内容 |
| --- | --- | --- |
| `local_web_workflow_runs_v1` | UUID runId | 业务绑定、冻结输入/YAML/哈希、状态/revision、opaque SDK checkpoint、结果证据及私有目录 |
| `local_web_workflow_leases_v1` | endpoint/Profile 哈希 | owner、递增 fencingToken、leaseUntil、runId |

报告仍写入原来的 `research_financial_analysis`、`research_investment_analysis`、
`macro_analysis`、`company_report_discovery`。新 taskId 是 UUID 字符串，同时提供
runId/engine/revision；历史数字 taskId 保留原含义，旧结果保持原来源格式。
研报发现结果与业务行在同一个事务中提交；投影使用执行身份/版本比较，拒绝旧结果
覆盖新任务。已有业务断言和冻结历史 fixtures 不改成新实现生成的预期值。

## 状态与故障

- `queued → running → succeeded/failed/interrupted`。账本入队后，业务行必须绑定相同
  runId 才能派发；两分钟仍未绑定且无 checkpoint 的入队记录会终止，允许显式重试。
- 同一数据库内同一个 endpoint/Profile 串行；租约 60 秒、每 10 秒续租。
  checkpoint/结果写入均校验 owner、fencingToken 和租约有效期。
  该租约不覆盖其他应用或其他数据库，请避免让其并发操作同一 Profile。
- 本地 worker 独立于 cron。`LOCAL_SCHEDULER=0` 不取消用户已经提交的研究任务。
  关闭页面不停止任务；后端退出停止本地后续动作，重启后续接原 SDK cursor。
- SDK 在点击/按键派发前持久化 cursor；模糊结果不得重放。
  进程中断且没有已确认 cursor 时失败关闭，不能自动重新提交。
- 恢复先读原完成凭据，再从原 cursor 继续。SDK 确认剩余步骤全部只读后，恢复会
  重新打开原 URL，避免仍存活但停止更新的流式 Page。新执行等待五分钟后，也至多
  做一次这种只读重开；发送前绝不通过此路径重试。无法证明恢复安全则失败，
  需要人工检查。冻结 YAML 不就地修补。
- 已完成执行只允许在校验过原 SDK 完成凭据存在后重新物化；凭据缺失则在连接
  浏览器前失败，不重新调用模型。用于修复结果适配，不能冒充重新研究。
- `cancel` 只停止本地执行，不声称撤销网页已经收到的请求或停止服务端生成。
- 旧 taskd 在途任务不会被转换或重发，必须人工核对；历史完成报告仍可读取。

## 配置与诊断

`LLM_RUNTIME=local` 是执行前提。需要相邻 `../cea` Rust workspace 和可访问的 CEA
Server；默认 `CEA_ENDPOINT=ws://127.0.0.1:9876/api/v1/ws`，Profile 可用
`LOCAL_WEB_RESEARCH_PROFILE` 覆盖。持久 Profile 需要事先登录 ChatGPT。

网页模型及 Power 映射在 `config/app/web-research.json`，页面选择器/完成门在
`config/workflows/chatgpt-research.yaml`。模型位置只辅助定位，发送前必须读回精确
模型名及所选思考强度，不允许静默降级。站点 DOM 改版会显式失败。

`GET /api/research/web-workflows/{runId}` 返回白名单任务摘要、是否有 checkpoint/结果，
不返回提示词、冻结配置、opaque cursor 或文件路径；GET 不写数据库、不提交任务。
`POST /resume` 仅恢复当前绑定的原任务；`POST /cancel` 请求停止本地执行。
所有路由受本机 Host/同源限制。

私有文件在 `LOCAL_DATA_DIR/web-research/<runId>/`（目录权限 0700）：
`workflow.yaml` 是冻结流程；`output/` 保存 SDK cursor、HTML/Markdown、完成凭据或
failure 诊断。失败页面可能包含账户和研究内容，不能公开上传；它们不由内容服务提供。

SDK 同时保留原始 DOM 文本、HTML、Markdown 和来源凭据。研报 JSON 从原始文本
解析，避免 Markdown 转换转义破坏 JSON。报告适配仅规范化 SDK 输出的一级数字
标题转义（如 `# 1\\.`），不补造章节、不放宽原业务校验。来源弹层解析失败会
阻断业务入库，站点明确标记渲染失败的回答同样不能发布。

## 验收

自动门：`npm run check:rust`、`npm run typecheck:web`、`npm run build:web`、
`npm run check:runtime-boundaries`、`npm run check:no-new-tables`、
`node scripts/build-valuation-revision.mjs --check`。相邻 SDK 运行 workflow 单元测试。
`backend/tests/web_workflow_runtime.rs` 验证四种准入/UUID、摘要隐私、只读 GET、
本机访问限制与取消语义，**不发送真实网页提示词**。

真实验收必须另用隔离 SQLite/数据/对象目录和闲置端口，经正常业务 POST 提交，
验证模型/Power、网页收件、SDK 完成凭据与来源、SQLite 业务投影、API 和重建后的
页面。随后在该服务执行 `BASIC_TEST_BASE_URL=... npm run test:basic`。
自动通过、真实网页收到请求、完整业务闭环是三类不同证据，不能互相替代。

本次实测结果和未覆盖边界见 [2026-10-31 验收记录](local-web-research-validation-2026-10-31.md)。
