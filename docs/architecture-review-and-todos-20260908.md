# 架构审查与实施 TODO（2026-09-08）

## 目标与原始发现

保留模块化单体、Hono 共享业务入口、本地 Node / 生产 Cloudflare Worker。生产禁止 LLM；股票 K 线仅雪球，基金净值仅东方财富。实施不新增数据库表，不覆盖原有未提交修改，不发布生产或重启现有服务。

审查发现：
1. 发布只检查后端类型，前端独立类型检查有 41 条错误；发布后只验证 health。
2. 页面环境策略分散；theta 本地页面漏入 Worker 优先路由清单。线上两个期权页面均实际返回 HTML，普通期权页面的线上差异仍需部署版本核对。
3. 公司/知识路由分别约 2476/2343 行，知识路由直接导入公司路由的业务函数及类型。
4. Vue 与 legacy runtime 双重维护页面状态，全局自定义事件充当隐式接口；页面逐个 IIFE 构建。
5. 投资分析读取时对账 taskd、落库，研究成果与缓存共用存储接口，缺少独立后台投影生命周期。
6. 本地 bindings 强制断言完整 D1/R2 类型；同步 SQLite 锁等待可能阻塞事件循环，需要契约及实际等待证据。
7. 相邻 file 依赖使构建输入不明确；Cookie 刷新写入受 Git 跟踪的配置。

## 共享契约和所有权

- API URL、成功响应及业务语义保持兼容；业务提取不重写已有公告变更。
- 页面策略使用 `config/page-manifest.json`：条目包含 `path`、`entry`、`runtime`（`all`/`local`）、`legacy`、`globalName`。前端 agent 负责建立和消费；协调者负责路由、部署、验证消费。
- 报告分析以普通输入和 Bindings/最小依赖为接口，不跨模块导入 Hono 路由。
- 后台研究对账只处理已提交任务，不隐式提交模型请求；使用既有 kv_cache，明确持久化与版本语义。
- 所有 agent 只实施及编写必要测试，不执行测试、构建或类型检查。全部 implementation_complete 后由协调者统一执行验证。
- 单一文件所有者；package.json、wrangler.jsonc、部署脚本及本文由协调者修改。

## TODO

状态：pending / in_progress / implementation_complete / done / blocked。代码写完不等于验收完成。

| ID | 工作与消费者 | 所有者 | 前置依赖 | 验收条件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| A1 | 修复前端类型契约，分离测试 tsconfig；消费者为构建与编辑器 | frontend | 无 | 前后端独立类型检查通过 | implementation_complete |
| A2 | 页面清单统一前端入口、legacy 标记和本地可见性；共享 ESM 构建 | frontend | 页面清单契约 | 本地页面可用，生产资源无本地页面；共享依赖有效 | implementation_complete |
| A3 | 报告页迁移为明确的页面状态/服务所有者，移除该页全局事件桥；其余 legacy 页面保留显式清单以支持逐页迁移 | frontend | API 兼容 | 报告分页、发现、正文交互通过浏览器验收，无重复初始化 | implementation_complete |
| B1 | 公司报告业务从路由提取 application/domain，知识通过业务接口调用 | report-backend | API 兼容 | 无跨模块 api 导入；报告/知识相关验证通过 | implementation_complete |
| C1 | 研究成果 repository 与后台完成对账，明确永久结果及版本、幂等条件 | research | 无新表；本地限定 | 无页面读取仍可落库；失败/重复对账不损坏已完成成果 | implementation_complete |
| D1 | 最小平台契约与本地实现收敛；记录锁等待、事件循环证据 | coordinator | 与 C1 不修改同一文件 | 两端契约验证；明确是否需要线程隔离 | implementation_complete |
| D2 | 统一发布门禁，消费页面清单并验证运行环境策略 | coordinator | A1/A2/B1/C1 | types、关键测试、schema guard、生产策略验证通过 | implementation_complete |
| D3 | 固定跨仓发布输入；凭据改为本地文件/Worker secret | coordinator | 保留现有凭据与会话 | 干净输入可核对、配置不含 Cookie、刷新与部署有明确契约 | implementation_complete |
| V1 | 全部集成后统一验证与文档关闭 | coordinator | A/B/C/D 全部 implementation_complete | 测试、构建、隔离运行环境、真实页面验证，记录外部阻断 | in_progress |

## 验证安排

开发阶段不运行测试。集成后先运行统一静态/单元门禁，再构建本地和生产产物；通过隔离端口与临时数据副本验证 HTTP、后台投影、页面策略及浏览器行为。生产线上只读抽查，不自动部署。现有外部数据凭据或服务不可用时记录明确边界，不能用备用数据源伪装通过。

## 执行记录

- 初始工作区已有公告、宏观页面/API、package.json、smoke-pages 和本地验证数据库修改，全部保留。
- 2026-09-08：建立文档与任务接口，等待并行实施。

- 并行代码已集成：B1、C1 implementation_complete；SQLite 已改专用 worker-thread，保留 30 秒锁等待但不阻塞 HTTP。
- 跨仓输入记录 revision 与 dist SHA256；Cookie 旧值保留到忽略的本地迁移备份，版本化配置移除该值，发布通过 stdin 上传 secret。

- 全部开发任务交接，开始 V1 集成后统一验证；此前未执行测试或类型检查。
