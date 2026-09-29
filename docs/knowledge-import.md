# 外部知识与资讯导入

## 职责与契约

stock-info 不采集资讯。订阅方或导入方负责取得来源授权、筛选可发布内容、提供稳定的来源标识，并调用 `POST /api/internal/knowledge/import`。接口使用独立的 `KNOWLEDGE_IMPORT_TOKEN` Bearer secret；未配置时拒绝所有写入。持有该 secret 即拥有发布权限，可指定任意符合格式的 `sourceKey`；当前没有逐来源 allowlist 或旧投资相关性门禁，须只向可信导入方分发，并在导入端完成筛选。生产与本地使用同一路由，但各自写入独立的 D1/R2 或 SQLite/本地对象目录。直接向 D1 写库、把 JSONL 目录当持久队列，均不是新导入契约。

请求为 `application/json`，示例：

```json
{
  "sourceKey": "licensed_news",
  "sourceItemId": "news-123",
  "sourceType": "information_feed",
  "sourceName": "授权资讯源",
  "title": "示例标题",
  "url": "https://example.com/news-123",
  "publishedAt": "2026-09-29T08:00:00+08:00",
  "body": "来源原文"
}
```

`sourceType` 可省略，默认 `information_feed`；一般知识文档可用 `external_document`。仅接受纯文本正文；PDF、HTML 和图片需由外部先处理，附件导入不属于当前接口。服务器不接受调用方指定的 `doc_id`、排序权重、提取状态或标签。URL 只允许 HTTP(S)，请求最多约 264 KiB，正文最多 256 KiB。外部方须妥善保护 token，不得放到浏览器或公开仓库。

## 存储和读取

- 服务端统一换行、去除首尾空白，计算正文 SHA-256；来源 key、来源条目 ID 和正文哈希确定不可变的 `doc_id`。同版本重试不会创建新文档，首次写入的标题、链接和时间保持不变；正文变化会产生新版本，同一来源条目的 `storyKey` 不变。若仅元数据需要更正，须另行定义有审计的更正操作，不通过重试暗改历史版本。
- UTF-8 正文字节数 **≤ 4096** 时，完整正文写入 `knowledge_docs.inline_content`，哈希写入 `inline_content_sha256`，不产生 R2 对象或 content ref。`summary`/`content_preview` 仍只是摘要／预览，不充当完整正文。
- 正文字节数 **> 4096** 时，先按内容哈希写入 `KNOWLEDGE_CONTENT_BUCKET`，再由 D1 批次写入 `knowledge_docs` 和 `knowledge_doc_content_refs`。对象上传失败不会发布数据库指针；数据库失败可能留下可复用的同哈希孤儿对象，应由后续生命周期维护清理，不能反向假设 D1 与 R2 是一个事务。
- `GET /api/knowledge/doc?id=...` 对短文返回 `content`，对长文返回 `content_url`；列表不返回完整正文。资讯页返回来源摘要及链接，不把外部原文当作经模型验证的信息记录。
- 新导入资讯使用 `feed.version=v2` / `importVersion=api-v1`，由独立 Bearer token 授权发布；不冒充旧 `v1` 的投资相关性门禁、模型提取合同或 `knowledge_information_records`。资讯页以“来源原文”标识。旧 v1 记录继续按原来的提取与发布规则读取。

## 上线与验收

1. 本地运行 `./start-local.sh` 完成同一套迁移和构建；在忽略提交的 `.dev.vars` 中设置 `KNOWLEDGE_IMPORT_TOKEN`。未设置 token 时接口必须返回 401。
2. 生产先应用远端 D1 migration `0148_inline_knowledge_content.sql`，再部署 Worker，并以 Worker secret（不是 `wrangler.jsonc` vars）设置 `KNOWLEDGE_IMPORT_TOKEN`。不允许修改 `LLM_RUNTIME=production`。
3. 分别导入一篇短文和一篇大于 4096 字节的长文，确认响应中的 `storage` 为 `d1`/`r2`，相同请求重试返回同一 `docId`；通过目标环境的 `/api/knowledge/doc`、`/api/knowledge/feed` 及远端 R2 对象核实可见性。健康检查和本地页面不能替代生产验证。

导入不会自动生成结构化信息记录或语义标签；若要给外部内容增加可信提取结果，须另设受控的本地处理／发布合同，不允许生产 Worker 调用 LLM，也不能让外部 payload 自称 `provenanceStatus=verified`。历史 JSONL 处理脚本保留供手工回填，不再由本地 supervisor 自动监听。
