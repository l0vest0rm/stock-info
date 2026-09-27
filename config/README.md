# 配置目录

`config/` 存放本地 Node、Cloudflare Worker 和仓库脚本使用的版本化输入，按消费者和生命周期分类：

| 目录 | 内容 | 主要维护方 |
| --- | --- | --- |
| `app/` | 页面策略、发布输入锁 | 构建与部署检查 |
| `knowledge/` | 知识处理、分类体系、资讯策略、R2 CORS | 知识与资讯处理链路 |
| `research/` | 有代码消费方的投研规则、注册表和任务参数 | 投研模块和脚本 |
| `backtest/` | 各自独立的回测策略与参数 | 回测脚本 |
| `generated/` | 东方财富公司行业画像快照 | `sync-eastmoney-company-em2016-profiles.mjs` |

原来的两份资讯门禁配置合并为 `knowledge/information-feed-policy.json`：`relevance` 保留门禁版本和规则，`whitelist` 保留独立版本的白名单。调度与发布设置仍在 `knowledge/information-feed.json`。

不要手工修改生成快照，应运行对应脚本。已删除重复的 Top300/模板映射快照及其生成器，并移除只被测试引用的旧本地投研流程、规则和测试；现行投研由 `src/modules/research/` 与 `research-eastmoney-em2016-industry-profiles.json` 承担。没有代码消费方的旧预处理、自动刷新、文件提取、经营分析参数和事实绑定草案也已删除。历史验收快照移至 `docs/archive/`，测试样例移至对应测试目录。消费方和生命周期不同的在用契约仍保持独立。

`research/` 中仍有由领域/应用代码引用、但尚未接入当前公开研究 API 的契约；它们不是旧本地 runner 的配置。若要进一步删除，必须连同所属模块、测试和存储契约一起审查，不能只删 JSON 留下断开的代码。

本地基金研究覆盖项放在 `research/fund-quarterly-research.local.json`（Git 忽略），可复制 `docs/examples/fund-quarterly-research.local.example.json`。`web/src/config/` 属于独立的前端配置区，不在本次整理范围内。
