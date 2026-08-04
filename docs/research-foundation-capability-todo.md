# 研究系统底层能力收口待办

> 状态：执行中。本文把可复用底层能力与公司研究页/工作台分开验收；它不把单页显示、临时 JSON、缓存命中或单一证券样本当成能力完成。
>
> 需求真值：[投资分析框架](./investment-analysis-framework.md)；研究功能交付状态：[交付待办](./investment-analysis-delivery-todo.md)。

## 分层原则

```text
源站 / 法定披露 / 已授权文件
  -> 共享采集、缓存、标准化、来源与版本契约
  -> 可复用领域读模型（财报、行情、知识证据、证券身份）
  -> 研究、公司、知识、行情等上层工作流
  -> 页面/API 适配器
```

上层不得绕过共享层直接选择数据源、重解释原始字段、伪造来源状态，或用页面状态替代领域门禁。共享层不得输出投资结论、用户决策或生产 LLM 能力。

## 已盘点的能力边界

| 能力 | 当前所有者 | 已有消费者 | 必须稳定的契约 |
| --- | --- | --- | --- |
| 证券代码/市场识别 | `src/shared/codes.ts` | finance、market、company、knowledge、research、security | 代码规范化、市场/证券类型；不得承担经营主体或权利推断 |
| 外部 HTTP/缓存/代理 | `src/shared/http.ts`、`cache-policy.ts` | adapters、finance、market、knowledge、company、macro | 超时、按域并发、缓存、失败可见；本地仅 `yahoo.com` 与子域经代理，生产直连 |
| 三地正式财报 | `modules/finance/application/load-financial-statements.ts` | finance API、company、knowledge、research 财务读模型 | A/H=Eastmoney、US=Yahoo；原始来源/币种/期间/单位保留；无自动 fallback |
| 法定披露核验 | `adapters/statutory-disclosures.ts`、research statutory application | research 财务核验、正式实际候选、知识导入 | 核验不能取代主财源；文件、字段、期间、修订与结果可回放 |
| 股票行情 | `modules/market/application/load-kline.ts` | market、company、research | 股票 K 线仅 Xueqiu；缓存交付位置不能掩盖原始来源 |
| 文档/版本/信息预处理 | `modules/knowledge/application/information-processing.ts` | 知识页、研究来源候选、法定披露导入 | document/result/version/run/content hash/原始 URL 不可丢失；LLM 仅 local |
| 来源证据与认识类型 | knowledge/research evidence ledger | 预测、经营、治理、行业、风险、快照 | 事实、观点、预测、假设、判断、个人决定不可合并；仅人工审核后跨层引用 |
| 运行时能力门禁 | `shared/llm-client.ts`、`shared/request.ts`、routes | knowledge、company、research、本地工作台 | production 不调用 LLM，写入/草稿端点 404；本地能力显式标注 |

## 可执行 TODO

每项完成都要有：领域契约/调用方边界、真实或受控来源验证、至少一个跨消费者回归，以及失败可见性。只有外部资料、授权或产品权限无法由代码解决的项目才标 `external-decision`。

### F1 财报统一读取契约（P0，进行中）

- [x] 将金融报表读取结果固定为独立的共享 read model：`source policy`、原始 provider、缓存交付位置、报告币种、会计口径、完整会计期间、修订状态、字段可得性和失败原因；禁止各上层模块各自推断这些字段。`financial-statement-read-model.v1` 的无抛出读取入口已覆盖 A/H/US 与不支持证券；法定源仍只作为核验，不会成为 fallback。
- [ ] 让 company、knowledge、finance API、research 使用同一财报读取/标准化契约；保留旧 API 适配器直到全部 consumer 迁移，不能静默改变旧返回形状。
- [ ] 针对 A/H/US 验证：主源失败显式失败、法定源仅核验、不自动 fallback、Yahoo 本地代理/生产直连、K 线不进入财报路径。

### F2 财报事实规范化与可比性（P0，进行中）

- [ ] 将报告期、频率（季度/年度/TTM）、流量/时点、币种、单位、会计/归属/EPS 口径、修订与来源 locator 作为共享事实身份；任何派生指标只能引用该身份。
- [ ] 将 Eastmoney、Yahoo 与法定核验的字段映射、不可比/冲突/缺失 reason code 集中维护；上层不得按展示标签或数组位置比对。
- [ ] 将金融、银行/保险/券商例外指标保留为 profile 选择后的独立事实，而非在 company/research 页面复制公式。

### F3 缓存、时效与来源健康（P0，进行中）

- [ ] 统一市场、财报、法定披露和知识来源的 freshness/expiry 语义；缓存命中必须保留 origin、更新时间和适用数据截至日。
- [x] 财报共享读入口已将主源错误、限流、超时、代理缺失、无主源数据和异常响应映射为机器可读 reason；默认 legacy finance payload 为兼容仍保留原形，调用方必须显式使用 read-model 格式取得健康状态。
- [ ] 建立跨模块 health read model，供 API 和页面只读使用；不能用“当前请求时间”冒充财务/证据截止日。

### F4 文档、版本与证据复用（P0，进行中）

- [x] 定义可复用 `source evidence reference` 最小契约：document/version/content hash、原始/内容 URL、发布日期、处理 run/model/prompt/input hash、定位符、实体映射和审核状态。读取时重新验证 candidate/review/information/result/run/version/document 链；已覆盖 eligible、review 撤销、版本过期和 provenance 篡改为四种不同状态。
- [ ] 所有研究候选（预测、经营、治理、行业、风险）只接收已审核的不可变 evidence reference；不允许页面文本、LLM 草稿或自由 URL 直接成为模型输入。
- [ ] 法定文件导入复用同一文档/版本链，但保留“法定核验”与“主结构化财报”角色差异。

### F5 身份与跨市场主体边界（P0，进行中）

- [ ] 将 `listed security -> confirmed operating company` 作为所有公司级事实、KPI 绑定和来源事实写入的共享前置条件；允许同一公司 A/H/ADR，拒绝未确认或跨公司绑定。
- [ ] 在数据库 trigger 与 application 层重复执行此不变量；上层路由的 URL 代码不能成为唯一保护。
- [ ] 每股估值、比较、税费/可达性/权利仍是证券级事实，绝不由经营公司映射补齐。

### F6 运行环境与写入能力（P0，已具备，持续回归）

- [x] `LLM_RUNTIME=production` 的 LLM 调用、研究/知识写入和草稿路径硬拒绝；本地才可运行。
- [x] 将 capability response 收敛为共享 `research-capabilities.v1` read model，避免页面靠环境字符串自行决定是否可写；研究路由的本地写入/草稿守卫均使用同一 predicate。`research-risk-review` 的全量 production 404 回归覆盖公司写入、全局来源身份写入、dossier 写入、行业写入和正式实际批处理；新增 capability model 回归确保只有显式 `local` 可启用写入或本地综合。

### F7 经营/行业传导的底层不变量（P1，进行中）

- [ ] 行业 KPI 绑定、经营来源事实与驱动计划均验证来源证券和目标公司一致；资料可跨同一公司多地证券复用，但不能跨公司。
- [x] TAM/SAM/SOM 增加只读层级校验：仅同期间、币种、数量级和 flow/stock basis 的唯一可比输入可验证 `TAM ≥ SAM ≥ SOM`；多候选、不同口径或层级反转显式阻断，不选取“最好看”的数。
- [ ] 经营事实→字段绑定保持人工审核、追加式、确定性预览；不得自动写入模型、情景、估值或结论。

### F8 消费者迁移与弃用（P1，待规划）

- [x] 已记录 finance/company/knowledge/research/market 对 F1–F3 共享能力的迁移边界、旧适配器和回归入口；F1–F3 完成后逐项迁移，不能让 research 单独拥有标准化逻辑。
- [ ] 任何旧缓存、`app_kv` 形态或 legacy response 的下线必须先完成消费者迁移与兼容回归；不得在研究页单独复制新的获取逻辑。

| Consumer | 当前读取依赖 | 旧兼容边界 | 迁移完成判据 / 回归 |
| --- | --- | --- | --- |
| finance API | `loadFinancialStatementReadModel`；默认继续投影 legacy payload | `/api/finance/:statementType` 经 `toLegacyFinancePayload` 返回旧形状，`format=read-model` 返回新契约 | 保持旧 API adapter；`test:finance`、API/页面 smoke |
| company | `loadActualAnnualProfitByYear` 经共享 read model 取得 income rows/health | 公司研报 PE 读取仍保留旧字段/单位 | F2 年度事实选择器；公司 API/页面 smoke |
| knowledge | `loadKnowledgeActualAnnualFinancials` 经共享 read model 取得 income rows/health | 知识研报指标仍保持现有字段和单位 | F2 年度事实选择器；information-processing/knowledge 回归 |
| research | `loadResearchFinancialFactSet` 经共享 read model 取得来源/health，研究层仍做 canonical fact 规范化 | 现有 coverage/法定核验账本不能被重写 | 将标准化与 mapping/reason code 移至 F2；`test:research`、A/H/US API/页面回归 |
| market | K 线由 `loadKline` 独立读取，不能进入财报路径 | 股票 K 线仅 Xueqiu；市场缓存不承担财报来源语义 | 只接入 F3 source-health/freshness projection；`test:xueqiu`、`test:http` 和页面 smoke |

现有 R2 财报 snapshot、`/api/finance/:statementType` legacy response，以及旧 `/api/report/forecast`/逐篇 `app_kv` 预测缓存均继续服务旧 consumer；在上表迁移与兼容回归完成前不得删除、改形或让它们成为新研究账本的权威来源。

## 明确不由基础设施伪造的交付

| 项目 | 状态 | 需要什么 |
| --- | --- | --- |
| 完整多来源研报预测与市场一致预期 | external-decision | 有使用权的原始材料、覆盖范围与独立性人工审核 |
| 行业 TAM/份额/客户/价格/产能真实样本 | external-decision | 可公开核验或获授权资料，以及公司口径对应 |
| 完整证券级股本、权利、税费和可达性 | 持续资料工作 | 各证券/期间的官方来源，不能用 EPS 分母或映射推断 |
| 标准/深度研究及目标价 | 被上游阻断 | F1–F7 的真实事实链与人工复核均满足后才可形成 |

## 当前实施顺序

1. 先收口 F1–F5 的共享契约与跨消费者回归；这是所有研究上层模块的前置。
2. 继续 F7 的来源归属/层级校验，确保经营与行业事实不会越过公司边界或形成伪精确结论。
3. 以真实 A/H/US API 与页面读取验证共享能力，而不是仅运行页面构建。
4. 最后迁移/收缩 legacy consumer；每次迁移后更新本文件与 `investment-analysis-delivery-todo.md`。
