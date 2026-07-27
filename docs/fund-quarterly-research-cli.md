# 基金季度持仓研究 CLI

该 CLI 从最近三个月收益排名中读取前 100 只基金，按基金名称去除 A/B/C 份额重复，只保留已经发布目标季度报告的基金。每只基金独立收集季报、前后季度持仓和个股行情，调用大模型生成一份 Markdown。

## 运行

```bash
npm run research:fund-quarterly
```

默认通过本地 Wrangler 接口 `http://127.0.0.1:8000` 获取基金和行情数据，
运行前请先通过 `./start-local.sh` 启动本地服务。需要使用其他环境时可传入
`--base-url URL` 显式覆盖。

默认模型是 `gpt-5.6-luna`，通过公共包
`/Users/terry/git/shared-ts/packages/llm-client` 的 Responses client 调用
`https://api.m2ai.cc/api/v1/openai`。默认认证直接读取
`~/.codex/auth.json` 的 `OPENAI_API_KEY`，不需要再次 `export`。
模型推理强度配置为 `high`。

如需为该 CLI 使用独立 key，可以创建已被 Git 忽略的本地配置
`config/fund-quarterly-research.local.json`：

```bash
cp config/fund-quarterly-research.local.example.json \
  config/fund-quarterly-research.local.json
```

然后只在本地文件中填写 `llm.apiKey`。不要把真实 key 写进受版本控制的
`config/fund-quarterly-research.json`。

默认输出目录是 `docs/research/funds`，文件名格式为：

```text
基金名称-基金代码-2026Q2.md
```

每次非 dry-run 执行结束还会生成季度索引：

```text
基金季度分析索引-2026Q2.md
```

索引按近三个月排名排序，列出近 1/3/6 个月收益、名称、代码、份额类别、
净值日期、季报发布日期和单基金报告链接。单基金运行会合并索引状态，不会
覆盖掉其他基金记录。

同时生成跨基金持仓统计：

```text
基金持仓统计-2026Q2.html
```

该表按“持有该标的的基金数量”降序排列，包含跨基金权重统计、近 1 周/1 月/
3 月/6 月/今年以来/1 年股价表现，以及 2026E、2027E、2028E 各自的研报预测
营收、营收增速、归母净利润、净利润增速和当前口径 Forward PE。研报预测按
年度简单平均并在数值后显示有效样本数；Forward PE 优先按当前总市值除以预测
归母净利润计算。HTML 表格支持吸顶表头、横向滚动，并可点击任意数字列进行
升降序排列。季度索引会链接到这份统计页面。

常用选项：

```bash
# 只抓取证据，不调用大模型
npm run research:fund-quarterly -- --dry-run

# 验证一只位于 Top 100 内的基金
npm run research:fund-quarterly -- --fund-code 005844 --dry-run

# 强制覆盖已经生成的季度报告
npm run research:fund-quarterly -- --force

# 查看全部参数
npm run research:fund-quarterly -- --help
```

## 幂等与失败恢复

- 完整 Markdown 文件是“已分析”的幂等标记；文件存在时自动跳过。
- `--force` 才会重新分析并覆盖。
- 输出采用临时文件加原子重命名，进程中断不会留下被误判为完成的 Markdown。
- 每只基金的结构化证据写入 `data/fund-quarterly-research/evidence/{季度}`，该目录已被 Git 忽略。
- 持仓统计状态写入 `data/fund-quarterly-research/holdings`；同一截止日且持仓证据未变化时复用状态并重新渲染，`--force` 可重新采集行情和研报，也可用于重试超时的数据源。
- 单只基金失败不会阻止其他基金；只要有采集或生成失败，CLI 最终返回非零退出码并打印基金代码和错误。

## 配置

- 运行参数、阈值、并发、模型和输出位置：[fund-quarterly-research.json](../config/fund-quarterly-research.json)
- 模型角色和硬性规则：[fund-quarterly-research-system.md](../prompts/fund-quarterly-research-system.md)
- 单基金报告结构：[fund-quarterly-research-user.md](../prompts/fund-quarterly-research-user.md)

密钥读取优先级是本地配置 `llm.apiKey`、`llm.apiKeyFile`、`apiKeyEnv`
指定的环境变量、`LLM_API_KEY`。模型仍可以通过环境变量覆盖：

- `FUND_RESEARCH_LLM_MODEL`
- `FUND_RESEARCH_LLM_BASE_URL`
- `FUND_RESEARCH_LLM_API_KEY_ENV`
- `LLM_API_KEY`（通用后备密钥）

## 计算口径

- “新进/退出”只表示进入或退出公开持仓明细。
- 加减仓使用 `个股持股数量 ÷ 全基金总份额` 的变化，消除大额申赎影响。
- 估算贡献使用季初、季末平均权重乘以报告期个股涨跌幅。
- 操作短期结果使用报告期末至运行截止日的价格表现，默认绝对涨跌不足 3% 记为中性。
- 港股或其他市场行情缺失时保留空值，不使用其他 K 线源补齐。
- 跨基金持仓表的行情仍只使用东财 K 线；研报预测主要覆盖 A 股最近 90 天，
  港股或无研报覆盖的标的保留空值。
