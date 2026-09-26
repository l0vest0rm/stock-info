# 信息记录统一存储：本地实施与验证记录

日期：2026-09-26。设计依据：[信息记录统一存储方案](knowledge-information-records-storage-design.md)。

**状态：本地代码改造、数据库迁移、历史回填和页面/API 验证已完成；远端发布执行集成及真实 D1/R2/Worker 验收未完成。** 不把本地成功或 SQLite 模拟发布测试表述为生产完成。

## 1. 已落地的数据结构

```text
knowledge_docs
  metadata_json.informationExtraction：当前成功结果、输入来源绑定、运行状态、候选审核材料
  metadata_json.feed：story、来源映射、去重、发布状态
      │ doc_id
      ▼
knowledge_information_records
  正式来源信息，只存一份
      ├── 资讯列表 / facets / story
      └── 按单条 entity 归属检索的总结材料接口
```

新增迁移 `migrations/0142_information_records_direct_document.sql`，重建既有信息表而非新增平行业务表。本地已删除 `knowledge_document_results`，信息表无 `result_id`，直接通过 `doc_id` 外键关联文章，文档删除时级联清理所属信息。

信息表实际字段：`information_id`、`doc_id`、`entity`、`entity_key`、`information_type`、`category`、`period`、`statement`、`forecast_measurement_json`、`sort_order`、`created_at`。

状态仍只在文档上存一份。`current` 除设计中的输入/正文/提示词/目录/模型信息外，包含 `recordCount`、`categoryCandidateCount`、`title`、`publishedAt`，供 SQL 资格检查与内容回读校验使用。`categoryCandidateCount=null` 不等于已经评估且没有候选。`provenanceStatus=verified` 仅指来源绑定核对通过，不代表现实真实性已被核实。

## 2. 实现位置

| 文件 | 实现职责 |
| --- | --- |
| `src/modules/knowledge/domain/information-records.ts` | 跨 Node/Worker 的记录映射、规范化摘要、当前有效性 SQL、标签派生。 |
| `scripts/lib/information-records-store.mjs` | 记录级实体解析、稳定 ID、同连接事务、租约核验、原子替换记录/标签/状态、失败保留上次成功结果、并发来源合并。 |
| `scripts/information-feed.mjs` | 新资讯直接使用表内记录；既有模型、prompt、48 小时窗口和每日限额保持不变。 |
| `scripts/lib/information-records-backfill.mjs`、`scripts/backfill-information-records.mjs` | 默认只读预检；逐文档归档原始状态后事务回填；来源不明保留为未核查；冲突中止、不静默覆盖；零模型调用。 |
| `src/modules/knowledge/api/information-feed.routes.ts` | 原 feed/facets/story 切换到信息表；文档级分页；校验整组记录摘要；新增实体材料读取接口。 |
| `scripts/build-prompts.mjs` | 同时生成 Node 和 Worker 使用的提取契约哈希，存储版本与模型契约版本独立。 |
| `scripts/filter-existing-knowledge-docs.mjs`、`scripts/cleanup-knowledge-docs.mjs` | 删除旧结果表依赖，普通清理保护有正式记录或成功提取状态的文档。 |
| `scripts/lib/information-records-reconcile.mjs`、`scripts/reconcile-information-feed-local.mjs` | 只物理删除尚无提取结果的确定重复文档；事务内重新核验扫描状态，保留已提取信息及空成功结果。 |
| `scripts/check-no-new-tables.mjs` | 已退役结果表只允许由指定历史 migration 创建，后续 migration 即使把表名重新加入 allowlist 也会拒绝。 |

API 用单条 SQL 中有序的相关 JSON 聚合读取文档记录，保持同一 SQLite/D1 查询快照；不会将文档与多条信息 JOIN 展开后再按展开行分页，也不会每条记录发一次网络请求。实体接口按记录分页，并对该记录所属的完整文档结果校验摘要。

## 3. 本地迁移证据

实际数据库：`data/local/stock-info.sqlite`。

| 检查 | 结果 |
| --- | --- |
| `PRAGMA user_version` | 149 → 150；只追加执行 0142 迁移。 |
| 文档总数 | 11702 → 11702。 |
| 资讯文档 | 2898 篇，状态均迁入 `informationExtraction`。 |
| 历史 JSON 信息 | 77 条，全部迁入 `knowledge_information_records`。 |
| 逐条内容比对 | 与迁移前备份按文档/实体/类型/类别/期间/陈述/measurement 比对，一致。 |
| 记录级公司身份 | 14 条有 `entity_key`，其余保留未归一状态。 |
| `knowledge_document_results` | 已不存在。 |
| `feed.records` | 0 篇文档残留。 |
| `feed.taggingStatus` | 0 篇文档残留。 |
| `PRAGMA integrity_check` | `ok`。 |
| `PRAGMA foreign_key_check` | 无违规。 |
| 回填重跑 | 2898 篇全部 unchanged，0 次新增修改、0 错误。 |

### 历史结果的有效性限制

174 份旧提取结果没有候选类别评估，且不符合当前提取契约/输入指纹；其中的 77 条信息均保留，但标为 `legacy_unverified`，不会被默认 entity 总结接口当作当前合格材料。另有 113 份旧“已打标”状态根本没有 records 数组，迁移为待处理、current 为 null，而不是猜成 `no_information`。

本次没有重新调用模型，没有借存储迁移提高契约版本、突破每日额度或重新处理超过 48 小时的历史文章。因当前本地旧数据均未通过当前契约验证，实体查询返回空有效材料是预期保护行为，不代表迁移丢失了 77 条记录。有效来源记录的检索、组合、分页与隔离已用隔离测试库验证。

## 4. 备份、归档和演练

采用 SQLite 一致性备份 API，未在 WAL 写入期间仅复制主数据库文件。

- 原始可恢复备份：`data/local/backups/stock-info-before-information-records-20260926T081326Z.sqlite`。
- 恢复/迁移演练库：`data/local/backups/information-records-restore-check.sqlite`。先验证恢复完整性，再在副本完整执行迁移、回填、重跑和内容比对。
- 正式回填前逐文档原始快照归档：`data/local/information-records-archives/`。归档文件核对通过后才修改文档。

验证产物均位于本地忽略目录，不混入业务事实表：

```text
data/local/information-records-preflight.json
data/local/information-records-rehearsal.json
data/local/information-records-rehearsal-repeat.json
data/local/information-records-rehearsal-verification.json
data/local/information-records-backfill-report.json
data/local/information-records-backfill-repeat.json
data/local/information-records-live-verification.json
data/local/information-records-health.json
data/logs/information-records-cutover-proof.log
```

## 5. 已执行的验证

| 验证入口 | 结果与边界 |
| --- | --- |
| `npm run test:feed` | 原资讯 32 项 + 存储/API/迁移等组合 51 项通过，共 83 项。 |
| `npm run test:local-runtime` | 25 项通过；其中部分 guard 测试与上项重复，不把这些简单相加当作唯一测试数。 |
| 空库迁移重放 | 全部 150 份迁移通过，再次执行 0 份；结果表已移除、外键正常。 |
| 非空旧表升级 | 保留原 ID、陈述、measurement、时间、排序与无明细的 no_information/needs_review；孤儿和非法数据会回滚。 |
| 事务与并发 | 删除后注入写入失败、旧租约、正文变更、并发来源合并、回填快照变化均已覆盖。 |
| 实体/API | 多公司记录隔离、未归一名称、历史更新、零条结果、文档/记录分页、摘要篡改、候选本地隔离、生产发布门禁均通过。 |
| 清理保护 | 已提取非空与空成功结果不会被重复文档清理误删；源状态变化、循环合并和已发布条目会拒绝。 |
| `npm run typecheck`、`npm run build:local` | 前后端类型检查、网页构建和 Node runtime 构建通过。 |
| `npm run check:no-new-tables` | 150 份迁移通过；退役结果表的新建拦截测试通过。 |
| `git diff --check` | 本次修改涉及范围通过。 |
| 标准 `./start-local.sh` | 以验收环境启动成功，实际 `/api/health` 返回 200 且 D1 为 true。 |
| 页面/API 冒烟 | 使用 `SMOKE_FILTER='^(health\|information feed page and API\|entity information record API\|retired information processing surfaces)$' npm run test:smoke:pages`，相关 4 项真实 HTTP 检查通过；未声称执行所有行情/外部数据的全站冒烟。 |
| 发布与判重预览 | `npm run publish:feed:dry-run` 返回 `remoteCalls=0, applyBlocked=true`；判重 dry-run 为 0 对。 |

验收进程临时关闭 feed/knowledge 调度、使用空 cron 配置、清空该进程的 REPORT_SYNC_TOKEN，避免验证期间调用模型或触发其他远端报告发布。没有改写 `.dev.vars` 或正式调度配置。验证结束后已停止此次验收实例；正常使用仍执行 `./start-local.sh`。

## 6. 可用入口

```sh
# 存储和 API 的组合验证（包含迁移/回填/发布辅助模块的隔离测试）
npm run test:information-records

# 默认 dry-run；当前已切换本地库应报告 changed=0
npm run backfill:information-records

# 只读发布资格预览，当前不会访问远端
npm run publish:feed:dry-run

# 正常本地服务启动
./start-local.sh
```

实体材料接口示例：

```text
GET /api/knowledge/information-records?entity_key=company%3A300308.SZ&limit=50
GET /api/knowledge/information-records?entity=<URL编码后的具体名称>&limit=50
```

二者必须且只能提供一个；可加 category、from、to 和返回的 cursor。时间范围按文档 sort_time 过滤，from 包含、to 不包含，不把该字段冒充事件实际发生时间。接口返回 information_id、doc_id、记录内容、entity_key、来源、成功输入指纹、结果集合摘要和 story 更新关系。它提供总结输入，不自动生成或持久化总结，也不把生成的总结写回来源信息表。

## 7. 尚未完成的远端部分

远端执行入口的完整改写两次被工具平台以“无法确定请求的安全状态”拦截，未绕过该拦截。当前采用明确的安全停止状态，而不是留下可误用的旧执行链：

1. `scripts/lib/information-records-publish.mjs` 已实现来源/契约/权限检查、包含 recordsDigest 的发布指纹、字段白名单、owner-fenced 分阶段 SQL、逐条内容回读核对和最后开启可见性门禁；4 项 SQLite 模拟测试通过。
2. `scripts/lib/information-records-publication-plan.mjs` 可基于新信息表生成只读预览；不调用网络。
3. `scripts/publish-information-feed.mjs` 检测到新 schema 后，只允许 dry-run。即使未来有人开启 publishRemote，旧 JSON 发布器仍会拒绝在新结构下执行。默认 `publishRemote=false` 未改。

后续仍须完成：真正的 R2/D1 调度适配、上传期间的本地快照重验、失败恢复/发布意图持久化、远端回读与条件曝光、配套 Worker/D1 顺序切换及真实生产验收。不能因为辅助模块测试通过就移除 guard 或自动打开远端发布。远端 D1 未迁移、生产 Worker 未部署、远端 R2 未上传。

本次工作保留了仓库原有未提交改动，没有自动 git commit，也没有把其它未提交清理改动作为本任务的提交内容。
