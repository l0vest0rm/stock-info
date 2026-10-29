# 本地 Rust 后端迁移

## 目标与当前边界

项目只在本地运行，完整保留现有业务。Rust 后端不得通过代理 Node、嵌入
JavaScript 或子进程调用 TypeScript 业务代码冒充迁移完成。

当前 Rust 仅实现运行时基础设施、健康检查与关注配置。全量业务仍由本地
Node 提供，`start-local.sh` 的默认入口尚未切换。未迁移的 Rust API 显式返回
501，不能作为整站可用性验收通过的证据。

Cloudflare 根部署配置、部署/回滚入口及 npm 远端写入命令已移除；本地 cron
独立使用 `config/app/local-runtime.json`，研究结果不再自动同步到生产。
历史远端维护脚本及 Worker 类型仍为待清理源码，不是支持的运行路径。
本次不操作线上资源，不删除线上数据库或对象。

## 共享契约

- HTTP 保持 `{code,msg,data}` 包装、现有路径和字段语义。Axum 子模块暴露
  `pub fn routes() -> Router<AppState>`，路径相对 `/api`。
- `AppState` 提供 `db`、`root`、`http`，以及 `setting`、`config`、
  `data_dir`、`market_store`、`knowledge_store`。
- `db.run` 将 SQLite 操作放在阻塞线程池；`query` / `execute` 使用 JSON
  参数数组。需要事务/CAS 的账本使用 `db.run`，不能用多次独立 execute 替代。
- `db.get_kv` / `put_kv` 复用现有 `kv_cache`；不可用普通 upsert 替代不可变
  版本写入。私有组合及观察研究的持久命名空间不得清理。
- `http::HttpClient` 提供 `text`、`json`、`cached_json`，统一超时、域并发、
  Yahoo 本地代理及请求缓存。提供方专用 Cookie/响应校验先于持久化。
- `storage::ObjectStore` 提供异步本地对象读写、JSON、原子替换和路径约束。
- 不新增表或迁移跟踪表。保留排序后的历史 SQL 与 SQLite `user_version`。
  迁移选择、执行与版本递增在同一 `BEGIN IMMEDIATE` 事务内。

## 全量验收门槛

下列项目全部通过后，才能切换 `start-local.sh` 并删除 Node 后端：

1. 行情与证券搜索：雪球股票 K 线、东方财富基金净值、证券身份与缓存策略。
   Cookie 缺失/失效必须报错，不得添加替代股票 K 线来源。
2. 财报与公司：各市场报表、季度/TTM、普通股权益 PB、分红、股本、公司
   信息、公告/研报发现、估值输入与估值区间。
3. 基金、机构持仓、13F、期权：所有现有接口与页面。
4. 研究：观察池滚动估值、依赖版本、并发 lease/fencing、研究证据、场景、
   历史 cohort 与冻结 outcomes；GET 只读、后台批次边界不变。
5. 私有组合：39 证券上限、公司集中度、现金/价格/FX、不可变版本与 CAS、
   任务复开、what-if 与真实快照分离。不能用历史回放替代新写入的并发验收。
6. 知识与资讯：导入、标签、筛选、全文、正文、本地对象生命周期、回调、
   研报转换、专题报告及原有工程处理功能。
7. 宏观与模型：官方来源策略、taskd/LLM 提交与恢复、结果对账、配额、
   提示词、后台调度及关闭页面后继续工作的语义。
8. 逐页检查真实响应与界面；`npm run test:basic` 对 Rust 服务完整通过，
   不允许删断言、伪造缓存值或保留 Node 运行时兜底。
9. 表审计按全量业务读写引用与历史迁移建立证据。没有证明废弃的表保留；
   空表不是无用表。本阶段没有新增或删除业务表。

## 运行与验证

完整本地功能仍使用 `./start-local.sh`。验证 Rust 时使用独立端口、独立
SQLite 与对象目录，避免修改现有数据库或中断活跃任务：

```sh
PORT=18000 LOCAL_DATA_DIR=/tmp/stock-info-rust-acceptance ./start-rust.sh
curl http://127.0.0.1:18000/api/health
npm run check:rust
npm run check:runtime-boundaries
npm run check:no-new-tables
```

`cargo test` 使用临时 SQLite，检查现有全量迁移、重入、失败回滚、未来版本
拒绝、并发迁移、账本保留、同源隔离、GET 不写入与配置往返；这些检查不等于
市场数据和研究业务已完成迁移。不要对现有数据库执行迁移仅为获得测试证据。
