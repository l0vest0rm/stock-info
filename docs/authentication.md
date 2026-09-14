# 账号与研报跳转

登录只在 `APP_RUNTIME=cloudflare` 的生产环境提供；本地 Node 不展示账号控件，也不要求会话。
网站普通页面和数据查询保持公开。生产环境右上角提供登录入口，以及退出和邮件重置。
首次登录时先提示再次输入密码，两次一致后自动创建账号并登录；已有账号直接校验密码。
修改邮箱或首次输入的密码会清除确认状态，重新检查。服务端在确认前不写账号或会话。
网页会话使用 30 天绝对有效期的 HttpOnly、SameSite=Lax Cookie；HTTPS 下启用 Secure。

生产环境的研报资讯标题及原文链接通过 `/api/knowledge/file?id=...` 跳转，服务端按文档类型检查会话。
生产环境公司研报列表按会话投影：未登录时不返回任何来源地址或可还原报告标识，标题跳到
`/login.html?returnTo=当前公司研报页`；登录后重新拉取列表，才返回可直接打开的原始地址。
生产列表响应禁止缓存并按 Cookie 区分，避免已登录响应泄漏给匿名请求。普通新闻链接保持公开。
前端由构建步骤注入 `__STOCK_INFO_APP_RUNTIME__`（本地为 `node`，Cloudflare 发布为 `cloudflare`），
后端由同名 `APP_RUNTIME` binding 判定；两端不通过域名或接口猜测环境。

账号仅使用两张表（迁移 `0139_auth_accounts.sql`）：

- `users`：邮箱、PBKDF2 密码哈希、状态和重置令牌哈希/过期时间。
- `auth_sessions`：随机会话令牌哈希、用户及会话期限。

每个用户只保留最新的重置链接，10 分钟有效。令牌放在邮件 URL 片段中，页面读取后清除
片段并通过 POST 确认。更新密码、清除重置令牌及撤销全部会话在同一个数据库事务中完成。
注册不验证邮箱归属；邮箱用于找回密码，与 Video2Down 现有账号方案一致。

生产使用 Cloudflare 原生 Rate Limiting bindings：登录/注册/确认重置按 IP 每分钟
30 次，重置邮件申请按 IP 每分钟 3 次。这是边缘节点内的近似限流。本地 Node 使用
同样限额的内存计数，不增加数据库表。

SMTP 配置从授权的 Video2Down 本地配置复制到忽略的 `.dev.vars`，发件人名为 `TINFO.CC`。
Worker 部署脚本运行 `scripts/sync-mail-secrets.mjs` 将其写入 Cloudflare secrets。
运行时不依赖另一个仓库。SMTP 采用 465 隐式 TLS；Worker 用 Cloudflare sockets，
Node 构建用 `src/platform/node/sockets.ts` 适配系统 TLS。生产保持 `LLM_RUNTIME=production`。

验证：`./start-local.sh`、`npm run test:smoke:pages`、`npm run verify:architecture`。
真实投递验收需使用获准的收件地址发出一封重置邮件，不能把 SMTP 鉴权成功等同于邮件到达。
