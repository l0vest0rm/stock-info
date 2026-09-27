# 资讯信息流：从来源文章提取信息记录

> 2026-09-26 本地存储改造已完成：`knowledge_information_records.doc_id` 直接关联 `knowledge_docs`，本地已删除 `knowledge_document_results`；77 条历史提取记录及 2898 篇资讯状态已迁移，不再保存 `feed.records` 副本。完整设计见 [信息记录统一存储方案](knowledge-information-records-storage-design.md)，核查数据、测试结果和未完成的远端执行集成见 [本地实施记录](knowledge-information-records-implementation-2026-09-26.md)。远端 D1/Worker 未切换，生产发布仍关闭。

> 2026-09-25：本地链路改用 `prompts/information-feed/` 的提取契约；远端发布仍关闭。无需新增数据库表，生产 Worker 不调用模型。此前 `entity/topic/focus` 的文章级打标方案废止，旧标签须在每日额度内重新处理，不能改名沿用。历史本地验证记录见 [information-feed-local-validation.md](information-feed-local-validation.md)，其中的旧标签质量结论不适用于本契约。

## 目标与边界

一张卡代表一篇文本来源的独有信息或同一事件的实质更新，而不是一个 URL。实体、公司、行业、信息类别是**从记录派生的索引**，不是模型另外猜出的文章级话题。实体不要求是上市公司；未解析出证券代码的组织、项目或具名市场仍可按原始名称筛选。模型只回答“来源明确说了什么”，不判断真伪、投资影响、重复或行业。首期仅处理原始格式确认为文本/HTML/Markdown 的腾讯自选股、财联社等来源；PDF 原件及其 Markdown 转换稿不进入资讯流。生产 Worker 只读，远程模型调用仅可由本地 Node 的 `LLM_RUNTIME=local` 发起。

“公司对应行业”仅在**公司身份唯一解析且已有可靠行业映射**时成立；一家公司的多元业务、未覆盖的海外公司、行业新闻和宏观政策无法由公司自动得出唯一行业。首期只使用现有 `eastmoney-company-em2016-profiles.json` 中已确认公司的行业，未命中的行业为空，不按公司名、文章标题或模型输出猜行业。该分类口径/覆盖率需要单独验收；它也不是文章具体涉及的业务细分主题。本期不提供细分 `topic` 筛选。

## 契约与数据流

```text
采集来源 + 原始格式/权限门禁
  → 工程去重：repeat 丢弃正文；new 保存全文；update 仅保存新增/修正段落
  → 本地投资白名单门禁：未命中者仅留标题/链接审计、不入库、不调用模型；不确定者默认拒绝
  → 本地 gpt-6-luna 单次提取 records 与待审 categoryCandidates（使用资讯流 system/user 提示词和现有 category 目录）
  → Schema/类别/期间/候选原文证据/模型身份/内容指纹校验
  → 正式记录存入 knowledge_information_records，以 doc_id 关联文章；记录级 entity_key 由公司名称/别名唯一精确匹配生成
  → 同一事务提交记录、派生 category/company 标签、informationExtraction 当前结果和本地候选
  → 公司标签经现有已确认公司档案派生行业；来源形态仍来自采集元数据
  → 本地卡片/API：展示本条记录的 statement，按来源/形态/公司/类别/已映射行业筛选
  → 从同一记录表提供 entity 检索，不受首页最新卡片和自动提取 48 小时窗口限制
  → 发布资格只读预览；新 schema 的远端执行入口在集成完成前被 guard 禁止
```

资讯流模型输出严格为 `{"records":[...],"categoryCandidates":[...]}`，两类合计最多 3 条独立信息。正式 records 沿用共享提取字段与 `config/knowledge-ontology.json` 的受控类别规则；调用只使用 `prompts/information-feed/document-analysis-system.md` 和 `prompts/information-feed/document-analysis-user.md`，不拼接另一份 user 提示词，也不维护第二套正式类别目录。确有可提取的主信息却不能准确归入现有类别时，模型须给出候选名称、信息陈述、与现有类别的区别和正文中逐字可查的证据片段；候选不是正式 category，不生成标签。实体必须是稳定具体对象，不能是“半导体”“业绩”等类别词。第三方预测数值只有原文口径齐全才填结构化 measurement，否则保留记录但 measurement 为 null。常规股价、资金流、技术面或只把其他事件当背景的行情稿，两类数组都应为空；空结果不是模型失败，也不凭标题补标签。对于 `update`，输入是本条独有段落，避免把前次背景重新索引为新信息。

各类别的中文翻译已直接写在 `config/knowledge-ontology.json` 的 `label` 字段；全部 56 个现有类别的较详细解释见[资讯提取类别释义（阅读用）](information-feed-category-guide.md)。这些阅读用文字不参与处理流程，修改它们不会改变模型输入或触发重新提取。

`category:<目录 ID>` 标签按记录类别确定性生成，第一条权重 100、后续独立类别依次递减；权重是展示顺序，不是模型置信度。`company:<证券代码>` 只在提取的 `entity` 与本次候选的名称/别名**唯一精确匹配**时生成；不能由正文任意提及或子串命中生成。实体仍以原名保存在记录中，稳定检索键保存在可空的 `entity_key`；无法解析成证券代码的组织/项目保持未归一，仍可在当前来源结果有效时展示、按类别或明确名称检索。不得把文章级公司标签反向分配给文章中所有记录。`informationType`、`period` 和预测数值保留在记录，不拼成组合类别；`industry` 从已解析公司的已确认档案派生，不存为模型标签。一个条目多条记录可以有多个类别/公司；只提背景的对象不在记录中，因此也不生成标签。

## 状态、存储与失效

复用 `knowledge_docs`、`knowledge_doc_content_refs`、`knowledge_doc_tags` 与既有 `knowledge_information_records`；不新增平行信息表。正式记录只存信息表，文档级状态保存于 `metadata_json.informationExtraction`，`feed` 仅保留资讯 story、来源、去重和发布信息。`informationExtraction.categoryCandidates` 仅在本地保存待审候选，原文证据校验失败则该次提取失败；不删除上次已提交的成功行集，也不把旧结果当成当前合格材料。

状态为 `pending | processing | complete | failed`；`current` 保存最后一次成功结果的 inputFingerprint、正文和各契约 hash、model、completedAt、recordsDigest、记录/候选数量及来源核对状态。两类数组都为空仍是合法 complete/no_information；有候选为 needs_review；首次未处理没有 current。成功写入在事务内重新验证租约和正文，再整体替换记录、标签与状态；失败只更新 lastAttempt 和退避。API 检查完整行集摘要、正文、标题、发布时间及提取契约，生产还要求发布许可。

模型提取契约仍为 `feed-tag-v5`，存储版本独立为 `information-records-v1`，不因搬迁数据重新调用模型。提示词、目录、公司候选策略、模型、正文和标题/发布时间仍进入输入指纹。`npm run backfill:information-records` 默认 dry-run；明确 apply 时先归档原始文档快照，再逐文档事务迁移。来源或契约不明的数据保留为 legacy_unverified，不能伪造有效状态。当前本地入库/提取由源文件变更触发，单批最多提取 20 次；满批后立即继续下一批，每日最多 500 次，额度耗尽后在 UTC 次日零点重新检查待处理项，保留 48 小时提取窗口与失败退避；远端开关仍为 `publishRemote=false`。

`repeat` 只保留最小来源映射，不写第二份正文，也不调用模型。近似改写靠文本和数字/实体/期间保护字段做工程判重，不能按类别或公司相同合并。`update` 仅保存新增段落，同一 `story_key` 默认展示最新卡片，并可展开历史独有更新。误吞不同数字/期间/事实状态比多一张相似卡更严重；工程无法证明重复时保留独立条目。存量判重清理只允许删除没有提取结果的确定重复文档，并在事务内复查扫描状态；有正式记录、空成功结果或候选的文档不能直接级联删除。

资讯具有时效性：自动入库与提取仅处理文章发布时间（缺失时用采集时间）处于最近 48 小时内的条目，提取按 `sort_time` 从新到旧执行，并在每次模型调用前再次校验窗口。扫描来源文件可回看 3 个自然日以覆盖 48 小时边界，但不等于允许提取 3 天前的文章。超过窗口的存量未提取条目保留在本地数据库供诊断，不再耗费模型额度；本地默认信息流隐藏它们，可通过“超过48小时未提取”筛选查看。来源绑定和契约仍有效的已完成历史条目仍可浏览；已迁移但未核查的旧结果保留在数据库，不默认当作有效展示或总结材料。一般保留期清理保护已有成功提取状态及正式记录的文档。财联社无推送接口，采集仍每 60 秒轮询，源文件未变化时不会周期运行提取。

当前 `npm run publish:feed:dry-run` 从信息表生成只读发布预览，明确返回 `applyBlocked=true`，零远端请求。新 schema 检测 guard 禁止旧 JSON 发布器继续执行；不能以打开 publishRemote 绕过这层保护。

目标远端链路仍仅接受最新、原始文本、非空正式记录、无待审候选、来源/契约/摘要一致且含有效标签的授权快照。`information-records-publish.mjs` 已提供发布指纹、白名单元数据、owner-fenced 分阶段 SQL、完整记录回读核对及最后开启可见性的辅助能力，并有 SQLite 模拟测试；实际 R2/D1 调度、失败恢复、本地快照重验和生产切换未接通。候选、租约、错误与本地审核字段不得进入远端；正式记录不得重新塞进 metadata。生产部署、远端 D1/R2 和真实 URL 验收必须单独完成，本设计不授权自动开启发布。

## 页面/API 与验收

`GET /api/knowledge/feed` 返回本条记录、`category:`/`company:` 标签、已映射行业及来源元数据，按 `(sort_time,doc_id)` 稳定游标分页；仅本地返回 `category_candidates` 并可用 `status=category_gap` 查看待审条目。`category_candidates=null` 表示尚未用候选契约评估，不等同于候选为空；来源绑定已经核对且契约仍有效的这类结果，可用 `status=category_unassessed` 查看。来源本身未核查或契约已过期的数据会显示为待重新处理/超过窗口，而不是混入当前有效记录。页面的“实体”筛选来自每条正式记录的 `entity_key` 或原始 `entity`，不局限于 `company:` 标签；调用 `GET /api/knowledge/feed?entity=...` 时应使用 `/facets.entities[].id`（未归一名称使用 `entity:` 加 URI 编码），API 保留 `company` 参数兼容旧调用。`entity`、`category`、`company`、`industry`、`source`、`content_type` 同维多选 OR、跨维 AND；其中实体、公司、类别、行业组合必须命中**同一条正式记录**，不能由一篇文章中互不相关的记录分别满足；命中记录排在卡片摘录首位。`source` 是采集渠道键，不是卡片显示的原始媒体署名 `source_name`。`/facets` 提供 `entities` 与 `categories`，不再提供 `topics`。卡片优先展示正式记录的 `statement`，无正式记录时退回正文摘要。本地“提取详情”区分正式记录与非正式候选；生产页面不显示该调试入口。原文入口仅指向获准文本来源。

新增 `GET /api/knowledge/information-records` 作为后续 entity 总结的材料接口：必须且只能提供 `entity_key` 或 `entity`，支持 category、from/to、limit、cursor。按记录归属查询，不取文章内其他公司的记录，也不套用首页每 story 只取最新或自动提取 48 小时窗口。返回信息 ID、doc_id、来源、输入指纹、记录集合摘要和 story 更新关系；未知实体身份明确保留未归一状态。默认排除未核查来源、旧契约、失败和待审结果，生产还要求正式发布权限。本接口不执行模型、不自动生成总结。

验收分层覆盖：业绩披露/预测（期间与口径）、订单/合作/监管、上市主事件与“破发”行情背景、产品价格与证券价格、行业/宏观无公司实体、未收录公司、多公司长文、重复与数字修订、PDF/未知格式。检查记录内容、空记录率、错误实体归属、类别误/漏标、公司精确匹配率、行业映射覆盖率及误吞新信息率，不能用模型调用成功率代替语义质量。先跑本地 `/api/health`、feed API、`npm run test:feed` 和页面冒烟；远端发布前还需实际模型样本抽检、远端 D1/R2/生产 API 验收。当前每日额度和旧标签回填使新的实际模型质量尚未验收。
