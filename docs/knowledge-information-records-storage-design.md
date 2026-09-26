# 信息记录统一存储方案：移除 knowledge_document_results

日期：2026-09-26  
状态：本地存储实现、数据库迁移、历史回填与页面/API 验收已完成；远端发布执行集成与真实生产验收未完成。  
范围：复用并改造 `knowledge_information_records`，删除 `knowledge_document_results`，支持资讯展示及后续按 entity 检索、总结。实施数据、测试证据、备份及剩余事项见 [2026-09-26 本地实施记录](knowledge-information-records-implementation-2026-09-26.md)。本文保留完整目标设计，不把目标中的远端部分表述为已完成。

## 1. 已确定的决策

1. 正式抽取信息只存于 `knowledge_information_records`，不新增 `knowledge_feed_information`、`knowledge_information_items` 等同构业务表。
2. 信息记录以 `doc_id` 直接关联 `knowledge_docs`，移除 `result_id` 及其外键；不再经过 `knowledge_document_results`。
3. 文档级提取状态、成功结果的输入指纹和审核信息保存在 `knowledge_docs.metadata_json`，不重复写到每条信息，也不单独建结果表。
4. 将现有 `metadata_json.feed.records` 迁入信息表。切换后移除这份正式结果 JSON；API 的 `records` 数组由查询组装，不是第二份持久化数据。
5. `knowledge_doc_tags` 继续作为从正式记录派生、可重建的页面索引，不作为另一份事实来源。
6. 保留现行 `entity / informationType / category / period / statement / forecastMeasurement` 提取契约。本次不恢复已废止的文章级 `topic/focus` 方案，不添加模型置信度或推演出的投资影响。

这里统一的是“某个来源所表达的信息”，不是把来源陈述升级为已独立核实的事实。资讯页面和 entity 总结是同一份信息的不同使用方式。

## 2. 改造前的实现核查依据（历史上下文）

以下记录的是制定方案时通过 MCP 读取的旧实现，行号对应当时版本，不是改造后的当前写入链路。当前实现以第 10 节列出的新模块及实施记录为准；不能把历史 migration 当成正在使用的运行链路。

| 核查项 | 当前实现及代码依据 |
| --- | --- |
| 结果表结构 | `migrations/0128_drop_knowledge_run_ledgers.sql:11–16`：只有 `result_id / version_id / outcome / created_at`，`version_id` 唯一，每篇当前文档只留最新结果。 |
| 信息表结构 | 同文件 `18–30`：正式信息通过 `result_id` 关联结果表。 |
| version 的含义 | `migrations/0126_replace_knowledge_document_versions_with_current_state.sql:63–81`：兼容视图使用 `doc_id AS version_id`，不是独立保存的历史正文版本。 |
| 实际提取写入 | `scripts/information-feed.mjs:200–236`：解析结果保存到 `feed.records / feed.categoryCandidates`，状态和指纹也写入文档元数据；标签另写 `knowledge_doc_tags`。 |
| 共享提取字段 | `scripts/lib/information-feed-extraction.mjs:26–96`：校验正式记录、候选类别及预测 measurement。正式记录与旧信息表字段基本一一对应。 |
| API 读取 | `src/modules/knowledge/api/information-feed.routes.ts:35–77`：发布资格和返回 records 直接依赖 `feed.records`；同一 story 默认只显示最新卡片。 |
| 发布器 | `scripts/publish-information-feed.mjs:67–86,175–184`：读取 JSON records，远端写文档、正文引用和标签，尚不写信息记录表。 |
| 清理依赖 | `scripts/filter-existing-knowledge-docs.mjs:95–103`：仍通过结果表删除旧信息。`scripts/reconcile-information-feed-local.mjs:72–80` 直接删除被判重文档。 |
| 本地事务 | `scripts/lib/local-d1-sqlite.mjs:9–27` 已启用外键、busy timeout 和 `BEGIN IMMEDIATE`；不能在其 SQL 输入中随意再嵌套事务。 |
| 迁移管理 | `scripts/local-db.mjs:18–38` 按已排序 SQL 文件数量推进 `user_version`，每份迁移在事务内执行。只能追加迁移，不能删除、改名或改写旧 migration。 |
| 当前边界 | `config/information-feed.json:2–13`：`feed-tag-v5`，自动提取窗口 48 小时，每轮 20 次、每日 200 次，`publishRemote=false`。 |
| Schema 约束 | `AGENTS.md:40–44` 禁止未经批准新增业务表；`scripts/check-no-new-tables.mjs` 扫描所有历史建表语句。 |

此前本会话只读检查中，本地 `data/local/stock-info.sqlite` 的结果表与信息表均为 0 行。这只是当时的本地状态，不证明远端 D1 或实施时仍为空。迁移必须按可能有数据设计，并重新核查所有目标环境。

## 3. 目标数据模型

```text
knowledge_docs
  文章身份、来源、发布时间、正文引用
  metadata_json.informationExtraction：文档级提取状态及当前成功结果元数据
  metadata_json.feed：资讯去重、story、来源映射、发布状态
       │
       │ doc_id，1 对 0..N
       ▼
knowledge_information_records
  每条来源信息，只保存当前一组正式结果
       ├── 资讯页面：按文档组织展示
       ├── entity 检索：按单条记录归属查询
       └── 后续总结：读取记录及来源，生成派生总结

knowledge_doc_tags：从正式记录派生的筛选索引
knowledge_doc_content_refs：继续提供正文位置和哈希
```

`knowledge_document_results` 不保留同名兼容表或长期镜像；与其有关的运行时依赖必须一起移除。`knowledge_document_versions` 兼容视图不在本次自动删除范围内，信息新链路不依赖它；是否清理该视图另行按真实调用核查。

## 4. knowledge_information_records 目标字段

下面是既有信息表改造后的目标结构，不是可直接对当前数据库执行的完整迁移脚本。

```sql
CREATE TABLE knowledge_information_records (
  information_id TEXT NOT NULL PRIMARY KEY,
  doc_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_key TEXT,
  information_type TEXT NOT NULL CHECK (
    information_type IN ('fact', 'guidance', 'forecast', 'opinion', 'event', 'relationship')
  ),
  category TEXT NOT NULL,
  period TEXT,
  statement TEXT NOT NULL,
  forecast_measurement_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(forecast_measurement_json)
      AND json_type(forecast_measurement_json) = 'object'),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (doc_id, sort_order),
  FOREIGN KEY (doc_id) REFERENCES knowledge_docs(doc_id) ON DELETE CASCADE
);

CREATE INDEX idx_knowledge_information_records_entity_key
  ON knowledge_information_records(entity_key, category, doc_id);
CREATE INDEX idx_knowledge_information_records_entity_category
  ON knowledge_information_records(entity, category, doc_id);
CREATE INDEX idx_knowledge_information_records_category_type
  ON knowledge_information_records(category, information_type, doc_id);
```

`UNIQUE(doc_id, sort_order)` 已提供按文档顺序读取所需索引，不必再创建等价索引。具体 entity 时间窗口查询还要结合执行计划，必要时使用既有文档时间索引，不提前堆叠所有索引组合。

| 字段或变更 | 规则 |
| --- | --- |
| `doc_id` | 替代 `result_id`，直接定位文章及其正文、来源。信息表不重复保存 title、url、source_type、published_at。 |
| `entity` | 保留经过现有 parser 校验的具体对象名称；不因身份映射失败而丢弃记录。 |
| `entity_key` | 可空的记录级身份检索键，由确定性解析生成，不要求模型输出。首期唯一命中已有公司候选时使用其 `company:<code>` 键。它是现有证券身份索引，不宣称已完成跨市场发行人统一。 |
| `information_type / category / period / statement` | 继续使用现有 ontology 和 parser，不因存储迁移改变类别或事实含义。 |
| `forecast_measurement_json` | API 中 `forecastMeasurement=null` 对应数据库 `{}`，读取时还原为 null；已验证对象原样存储。不完整或不合法的旧数据不得静默补值。 |
| `sort_order` | 每篇当前正式结果从 0 开始的展示顺序，不作为永久信息身份。回填旧顺序可在保持相对顺序的前提下归一。 |
| `created_at` | 新抽取使用毫秒时间戳；迁移保留已有创建/提取时间，不用回填时间伪装为信息发生时间。 |

### 4.1 entity 归一边界

复用 `companyTagsForRecords()` 的唯一精确匹配规则，但把匹配结果落实到每条 record，再由 record 派生文章标签。歧义匹配、被配置排除的错误代码、未覆盖组织或项目均保持 `entity_key=null`。

不把文章级公司标签反向复制给该文章所有记录。一篇文章有 A、B 两家公司时，查询 A 的总结材料只能选 A 的记录，不能把 B 的记录一起带入。

首期非公司实体仍可按明确名称精确查询，并在结果中标注未归一；不按同名强行证明是同一现实对象，也不靠名称 hash 伪造可靠身份。本次不新增 entity 主表、别名表或关系表；全面跨来源实体消歧是后续独立需求。

## 5. 文档级状态：保留职责，合并位置

统一使用 `knowledge_docs.metadata_json.informationExtraction` 保存文档级提取信息。该对象只保存状态、指纹与本地审核产物，不保存正式 records 数组。`feed` 保留资讯入口特有的 story、来源、去重、发布信息。

目标对象包含以下部分：

| 部分 | 建议成员 | 语义 |
| --- | --- | --- |
| `status` | `pending / processing / complete / failed` | 最新处理尝试的运行状态。 |
| `current` | `storageVersion`、`outcome`、`inputFingerprint`、`contentSha256`、`contractVersion`、`promptHash`、`categoryCatalogHash`、`candidatePolicyHash`、`model`、`completedAt`、`recordsDigest`、`recordCount`、`categoryCandidateCount`、`title`、`publishedAt`、`provenanceStatus` | 最后一次已提交的成功结果元数据，首次成功前为 null。它与信息表当前行集在同一事务中更新。 |
| `lastAttempt` | 尝试指纹/契约、租约 owner/until、尝试时间、重试次数、nextRetryAt、error | 调度与失败诊断；失败不得覆盖 `current` 的成功时间和指纹。 |
| `categoryCandidates` | 候选数组，未评估时为 null | 仅本地的当前结果审核材料；不进入正式信息表或远端发布快照。 |

`storageVersion` 使用独立的存储版本，例如 `information-records-v1`；不能为了把 JSON 搬到表就提高模型提取契约版本、触发全部重新调用模型。正文、prompt、ontology、模型、候选策略等输入指纹仍沿用现行规则；现有记录的有效指纹可直接迁移。

`outcome` 与 `status` 不是同一件事：

| 情况 | status | current.outcome | 正式记录 |
| --- | --- | --- | --- |
| 尚未处理 | pending | current 为 null | 0 |
| 成功且无正式信息、无候选 | complete | no_information | 0 |
| 成功且有正式信息、无候选 | complete | extracted | 1..N |
| 成功但存在待审候选或审核问题 | complete | needs_review | 可以有 0..N 条 |
| 调用或校验失败 | failed | 保留上一次成功值，或 current 为 null | 不破坏上一次成功行集 |

没有正式行不等于没处理。空成功结果也必须提交 `current` 指纹和完成时间，防止重复花费模型额度。`categoryCandidates=null` 不等于 `[]`，不能把“尚未评估类别候选”误判成“没有待审问题”。

迁移对应关系：将原 `feed.taggingStatus`、`taggingInputFingerprint`、`taggingContentSha256`、`tagContract`、各 hash、`taggedAt`、租约、失败信息和 `categoryCandidates` 移入以上单一命名空间；切换后删除旧提取字段。`feed.publishAllowed / publishedFingerprint / sources / storyKey / previousItemId / kind` 等仍属于 feed，不搬动。

迁移旧结果表时必须保留每条 outcome，包括没有任何明细的 `no_information`。历史数据缺失的模型、输入指纹和正文绑定信息保持未知，`provenanceStatus=legacy_unverified`；只有可验证的来源绑定才标记 `verified`，不能拿当前正文哈希补写成历史模型实际看过的输入。

这里的 `provenanceStatus=verified` 仅表示“记录与抽取输入、正文及契约的绑定已经核对”，不表示 statement 的现实真实性已经独立核实，也不表示候选审核通过。来源绑定有效性、内容审核状态和信息性质必须分别判断；不得因为该字段为 verified，就把 forecast/opinion 当作已确认事实。迁移时能取得原始抽取输入的，校验必须使用当时的输入范围；例如现行脚本传给模型的正文最多为前 12000 字符，不能用全文其他位置的片段替代当时可见的候选证据。

## 6. 写入、幂等与一致性

模型调用和结果校验发生在数据库事务外，不能持有数据库写锁等待网络返回。开始时沿用有限租约；成功提交时在事务内重新验证租约 owner、正文哈希与期望输入，防止旧任务覆盖新结果。

一次成功提交必须作为一个整体完成：读取并合并最新文档元数据；核验租约；替换该 `doc_id` 的正式记录；重建该文档的公司/类别标签；更新 `informationExtraction.current` 和候选；将状态改为 complete 并释放租约。任何 SQL 失败均回滚，不能出现“状态已成功、明细只写一半”。

事务开始后的校验失败必须阻止整个后续写入，不能只执行一条影响 0 行的条件 UPDATE 后仍无条件删写 records。不能把事务外读取的整份 metadata 覆盖回去，丢失并发合并的来源或发布状态。本地使用现有事务 helper 或等价的同连接事务；远端写入另按实际 D1 执行能力验证，不能假定多个 CLI 请求天然构成事务。

新 `information_id` 建议由规范化的 `[doc_id, inputFingerprint, record内容, 相同record出现序号]` 确定性生成。内容不含展示顺序和可变的 `entity_key`，但包含原始 entity、type、category、period、statement、measurement。相同输入和相同输出重放不产生新身份；内容变化不得复用旧 ID；仅顺序或身份索引修正不应重写原始信息身份。旧关系表迁移保留已有 information_id。

`recordsDigest` 为当前规范化且有序的记录集合摘要，纳入记录 ID、内容、顺序和解析后的 entity_key；空集合也有摘要。它用于迁移核对、远端回读和总结输入失效判断，不是另一份信息正文。

失败只更新尝试状态与退避，不预先删除成功记录。普通查询必须检查当前成功结果是否仍匹配正文和契约；保留下来的旧数据不自动具有当前有效资格。生产维持现有严格状态/资格门禁，本地诊断可以显式查看旧结果，但不得混入默认 entity 总结输入。

## 7. 读取与 entity 总结

### 7.1 资讯页面/API

保留 `/api/knowledge/feed`、`/facets`、`/story` 的既有业务行为和 records 字段形状，records 改为从信息表读取。列表先确定分页文档 ID，再批量按 `doc_id` 读取明细并按 `sort_order` 组装，避免 N+1 查询；不要直接 JOIN 一对多明细后对展开的行分页。

`feed.records` 的 JSON 非空检查改为对已验证当前快照的 records `EXISTS` 检查；标签、状态、正文哈希和契约检查迁到新的元数据位置。列表、facets、story、待审筛选使用同一资格判断，避免不同接口显示互相矛盾的状态。

两类数组都为空仍是合法 complete；本地页面可回退原文摘要。生产只展示已授权发布且当前有效的非空正式记录，候选详情仍仅本地可见。API 可增加 information_id 便于追溯，不要求前端修改提取字段的语义。

### 7.2 entity 检索和未来总结

面向总结的读取以单条记录为单位，按 `entity_key` 查询；未解析实体使用显式名称查询并保留未归一标识。返回信息 ID、doc_id、陈述/类别/期间/类型、来源、发布时间、当前成功输入指纹、recordsDigest 及 story 更新关系。

查询应通过共享 eligibility 逻辑排除过期契约、正文已变更、迁移来源不明和待审记录。可将“待审材料”作为显式独立输入集合展示，不能混入默认有效材料。

48 小时是自动采集/提取窗口，不是信息保存期限。按 entity 总结可查询已完成的历史信息，不得为沿用资讯页面窗口而只查询 48 小时。文章发布时间、采集/排序时间、记录 period 和信息发生时间必须区分；当前 feed 的 event_time/sort_time 不能直接当作模型确认的事件日期。

同一 story 的 update 只保存独有段落，因此总结不能照搬首页 `row_number()=1` 的最新卡片筛选。应取范围内相关的全部有效记录；出现修正或冲突时保留时间与来源解释，不简单把所有旧陈述都当成现状。

同一陈述来自不同来源可以保留多条来源信息，这不等于同一次抽取双写。不得只因 entity/category 相同就合并删除；去重和合并表述在材料整理层处理。story.sources 可能包含继承的传播来源，不能把每个来源都宣称为独立支持该条 delta 的证据。

总结是派生产物，不写回正式信息表冒充来源事实。未来持久化总结时应记录所用信息 ID、输入集合摘要、模型/模板版本和生成时间。当前只保留当前抽取结果，不承诺重现任意历史版本；需要严格历史审计时应另行设计不可变证据快照，不在本次顺带建表。此次只打通可查询、可追溯基础，不要求同时开发完整总结生成系统。

## 8. 安全迁移和回填

### 8.1 实施前预检

先对目标本地数据库及后续拟迁移的远端 D1 分别核查表结构、行数、外键、索引、触发器、视图、迁移进度、存量 JSON records、有效与待审数量。确认旧 `version_id` 能映射到真实 doc_id；不依赖兼容视图的过滤条件来掩盖孤儿记录。

本地采用数据库一致性备份方式，不能在 WAL 写入中只复制主 sqlite 文件；远端先完成可恢复备份/导出并验证恢复流程。迁移窗口内暂停资讯提取、发布和相关清理写入；执行中的任务须结束或失去提交租约。远端发布开关保持关闭，不因写了本方案而自动开启。

### 8.2 迁移既有关系数据

追加新的 migration，实施时选择最新可用序号，不改写 `0126 / 0128 / 0141` 等旧文件。先将旧结果表的文档级状态迁到文档元数据，再重建既有信息表以替换外键和唯一约束，保留信息内容与身份。映射路径为 `record.result_id → result.version_id → knowledge_docs.doc_id`，必须逐项验证。

只重建用户指定复用的既有业务表；迁移内部使用过渡名称时，不能留下长期副本或引入其他业务表。按目标引擎验证复制、外键约束和 drop/rename 顺序，不假定 SQLite 的 TEMP 表或关闭外键手法可直接用于远端 D1。

发现孤儿记录、一个文档有互相冲突的结果、重复 ID 或异常 measurement 时，预检报错并停止受影响的破坏性步骤；不能用 INNER JOIN、`INSERT OR IGNORE` 或裸 DELETE 静默丢弃。迁移审计至少核对原信息 ID 集合、每文档数量、规范化内容摘要、空结果状态及 `PRAGMA foreign_key_check`。

全部引用解除且状态与明细核对通过后，删除 `knowledge_document_results`。本地旧表为空也必须测试非空数据迁移，不以“当前没数据”替代保全逻辑。

### 8.3 将 feed.records 搬入信息表

提供默认 dry-run 的回填工具，明确区分三类：

| 数据情况 | 处理 |
| --- | --- |
| 当前有效完整结果，包括已完成的历史资讯 | 复用现有 parser 与指纹校验，逐文档导入；不调用模型、不耗每日额度、不受新提取 48 小时窗口限制。候选原文 evidence 仍要校验。 |
| 旧契约、缺失候选评估、来源哈希不明或无正文 | 保留可恢复数据并标注 legacy_unverified/待审，不伪造合格状态；重新提取仍受既有窗口、次数与退避限制。 |
| 同一 doc 同时有旧关系数据与 feed JSON | 比较来源绑定与内容摘要。相同则保留一套既有信息 ID；冲突则停止该文档切换并报告，不能两套都插入、随意覆盖或合并成一个成功批次。 |

每篇文档在事务中写入正式记录、状态/候选与标签，校验完成后再删除旧 `feed.records` 及已迁移的提取字段；失败保持原数据可恢复。回填必须可重复执行，崩溃重启不新增重复记录。只对验证完成的文档设置 `storageVersion=information-records-v1`；不能把“缺少 JSON 且新表零行”猜成合法 no_information。

远端历史快照本来不含 categoryCandidates，不能仅因字段缺失就推断为已审或未审；应与可信本地发布快照及发布指纹对照，不能为了回填把候选上传到远端。

迁移期允许新代码按明确的 storageVersion 为单篇文档选择一种读取格式，但禁止无条件 UNION 两种来源或长期双写。所有可处理文档完成切换并核对后，移除旧读取分支。异常数据进入受控备份/诊断清单，不作为另一份在线权威信息源。

### 8.4 Schema guard 与回滚

删除表名白名单中的旧结果表时，历史 migration 中的 CREATE TABLE 仍须被正常允许。应把它登记为“仅允许指定旧文件创建、后续禁止重建”的退役表，并补测试；不能把退役表全局放行，否则新 migration 仍可误建。当前 guard 对既有历史宏观表的处理不能直接当作有文件边界的禁建规则。

迁移需要同步代码版本。旧程序不能再向已迁移数据库写 feed.records 或 result_id。失败时保持维护状态，依据已验证的备份恢复数据库和匹配代码；仅回退代码无法恢复已删除表和旧数据。若迁移后已有新写入，须先保全新数据再制定恢复步骤，不能直接覆盖为旧备份。

## 9. 远端发布与删除生命周期

> 当前实施边界：已完成快照/指纹/owner-fenced SQL/内容核验辅助模块及 SQLite 模拟测试；远端执行入口的完整改写被工具平台拦截，当前新 schema 只支持发布 dry-run，旧发布执行链被 guard 禁止。以下远端流程仍是目标，不代表 D1/R2/Worker 已部署或验收。

发布器从正式记录表构建同一文档的已校验快照，发布指纹纳入存储版本和 recordsDigest，避免仅 statement 变化却被误判为无需发布。R2 内容上传成功后再写 D1 元数据、信息行、标签；本地 current 与 records 必须在同一读取快照中取得，上传期间本地变更需在提交与记录发布指纹前重新检查。

远端按文档完成可验证的原子替换，或采用明确的发布门禁确保任何中间状态不可见；不能假设当前多个 SQL 文件/CLI 请求自动原子。回读核对文档、正文哈希、信息 ID/数量/内容摘要、标签和发布指纹；仅核对 docs/tags 数量不足。只在核对成功后记录本地 publishedFingerprint。

生产快照不包含本地候选、错误详情、租约等字段；正式 records 已独立入表，不重新塞进 metadata。保持现有权限、来源格式、契约和非空记录门禁，不借迁移放宽发布资格。

信息行使用 `ON DELETE CASCADE` 跟随文档生命周期。清理脚本删除文档时不得留下信息孤儿；去重合并前必须确认不会丢失独有记录，不能只凭旧文章判重结果盲目级联删除新信息。普通 48 小时到期不删除已提取历史信息；远端展示下架也不得自动反向删除本地研究材料。未来被总结引用的材料清理需配套失效或快照策略。

## 10. 开发落点与验收清单

| 文件/模块 | 必须完成的调整 |
| --- | --- |
| `migrations/` | 追加迁移；重建既有信息表，增加 doc_id/可空 entity_key，迁移空结果状态，解除依赖后删除结果表。 |
| `scripts/information-feed.mjs` | 写入信息表；状态迁入 informationExtraction；同事务提交明细、标签、成功元数据。 |
| `scripts/lib/information-feed-extraction.mjs` | 保留语义校验契约；拆出可复用的记录级身份解析，标签由其结果生成。 |
| `src/modules/knowledge/domain/information-records.ts`、`scripts/lib/information-records-store.mjs` | 统一 JSON/SQL 映射、稳定 ID、集合摘要、状态映射、有效性判定，避免 API 与脚本维护不同规则。不得引入新业务表。 |
| `scripts/backfill-information-records.mjs` 及其 lib 模块 | dry-run、幂等回填、逐文档校验、冲突/未知来源报告、零模型调用。 |
| `src/modules/knowledge/api/information-feed.routes.ts` | list/facets/story 和各状态筛选改读新存储；保持正确的文档级分页和有序 records。 |
| `scripts/publish-information-feed.mjs` | 新快照发布、信息行回读、摘要指纹、下架一致性、本地审核字段隔离。 |
| `scripts/filter-existing-knowledge-docs.mjs` | 去除 result/version 间接删除路径，按直接文档外键工作。 |
| `scripts/reconcile-information-feed-local.mjs` 及其他文档清理入口 | 核查级联删除、独有信息保护、远端协调和历史保存策略。 |
| schema guard/allowlist/test | 旧 migration 可重放，但新 migration 不得重建退役结果表。 |
| `docs/information-feed-design.md` | 实施成功后将“当前实现”更新为新链路；此前只记录目标方案入口。 |

- [x] 本地环境已重新核查，完成一致性备份、恢复验证和真实数据副本演练；远端未核查、未迁移。
- [x] 空库完整迁移重放、旧版非空库升级均通过；信息 ID、来源关联、内容、顺序、时间不丢失。
- [x] 迁移保留 no_information 与 needs_review，包括没有明细的结果头；孤儿/冲突用例会中止而不是静默丢弃。
- [x] 成功结果零条/一条/三条、仅候选解析、正式记录与候选混合、未知候选评估均有测试；本次未调用模型做新样本语义验收。
- [x] 同输入重放、回填重跑不重复；内容改变不会让旧 ID 指向新陈述。
- [x] 事务中途失败、租约丢失、正文变化、并发来源合并均不会造成部分提交或覆盖新状态。
- [x] 当前有效性检查覆盖正文/hash/契约；失败或旧契约资料不进入默认总结材料。
- [x] 多公司文档按 record 归属检索；歧义实体不误匹配；非公司记录不会丢失。
- [x] API 文档分页、records 顺序、facets、story 历史与本地审核/生产隔离测试通过；生产隔离为本地集成测试，不是远端验收。
- [x] 当前有效的已完成历史信息可查询，超过 48 小时未提取的条目仍不自动调用模型。
- [ ] 远端发布执行适配与真实回读验收。内容摘要、分阶段可见性和旧 owner 拦截的 SQLite 辅助模块测试已通过；默认远端开关仍关闭，新 schema 的实际发布被 guard 拒绝。
- [x] 本地信息表无 result_id，运行时不依赖结果表，正式 records 不再在 feed JSON 中重复保存。
- [x] 已执行 `npm run test:feed`（32+51 项）、`npm run test:local-runtime`（25 项）、`npm run typecheck`、`npm run check:no-new-tables`；标准 `./start-local.sh`、真实 health/API 及通过 SMOKE_FILTER 选取的 4 项资讯相关页面冒烟通过。未执行全站行情冒烟，远端验收仍待完成。

### 10.1 分阶段实施顺序

| 阶段 | 交付内容 | 进入下一阶段的条件 |
| --- | --- | --- |
| A：方案落库 | 保存本文，并在 `information-feed-design.md` 标明现有实现与目标方案的区别。 | 本阶段只修改 Markdown，不新增迁移、不执行删表，不启动自动迁移流程。 |
| B：开发与隔离验证 | 完成共享存储/状态映射、追加迁移、回填工具、API、发布器和清理脚本的配套修改；在隔离测试库验证空库及非空旧库。 | 迁移、回填、幂等、失败回滚、外键和页面相关测试通过；运行时代码已不依赖旧结果表，不能只完成 DROP TABLE。 |
| C：本地切换 | 重新预检、完成一致性备份，暂停相关写入；应用已验证迁移与回填，核对正式记录及空结果状态，再用匹配的新代码启动本地服务。 | 本地 health/API/页面与 entity 记录检索验收通过；在线正式 records 只保留表内一份，旧 JSON/旧字段按已验证的切换标记清理。 |
| D：远端切换 | 另行核查远端 D1 数据与备份，用匹配的 schema、Worker 和发布器执行受控切换及回读验证。 | 真实远端 schema/API 验收通过；未经独立发布批准仍保持 `publishRemote=false`，不能因本地成功自动开启。 |

迁移文件和使用新结构的代码必须作为同一个发布单元准备完成。`./start-local.sh` 会自动应用本地迁移，因此不能先把删表 migration 放进活动工作区并启动旧代码，再补写兼容逻辑。实施时还要核查部署脚本的 D1 迁移/Worker 更新顺序，避免旧版本在迁移窗口继续写入。

**当前状态：A 完成；B 的本地代码与隔离验证完成、远端发布执行集成尚缺；C 本地迁移和页面/API 验收完成；D 未执行。** 本地现有 77 条历史信息已完整搬入信息表，2898 篇资讯状态已迁移，结果表已删除。缺失契约验证的历史数据保留为未核查，发布入口保持关闭，详见实施记录。

## 11. 完成标准

最终数据库只以 `knowledge_docs → knowledge_information_records` 表达文章与正式信息的关系；文档级提取状态并未丢失，只是不再单独占一张结果表。

信息提取一次、正式结果存一份，资讯页面与 entity 整理共享读取。来源可追溯、空结果不重复处理、失败不破坏上次成功数据、迁移不丢历史信息。

本地改造已按实施记录执行并验证；远端目标尚未完成，不应宣称整个跨环境方案已全部交付。后续应先完成安全的远端执行集成与独立验收，再考虑另行批准发布。
