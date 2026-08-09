# 投资分析排队 CLI

该命令复用投资分析页面使用的本地 API 队列，只负责确认任务已经写入队列，
不会等待本地 runner 或报告生成完成。运行前先启动 `./start-local.sh`。

```bash
npm run research:investment-analysis -- 300308.SZ
npm run research:investment-analysis -- 300308.SZ \
  --model gpt-5.4-mini --reasoning-effort high
```

默认模型为 `gpt-5.6-luna`，默认思考深度为 `max`。可用模型为
`gpt-5.6-luna`、`gpt-5.4-mini`；思考深度可选 `none`、`low`、`medium`、
`high`、`xhigh`、`max`。本地 API 地址默认为 `http://127.0.0.1:8000`，
需要其他地址时传入 `--base-url URL`。

CLI 的请求等价于页面点击“生成/重新生成报告”发送的
`POST /api/research/company/:code/operating-analysis/refresh`，并额外带上选择的
模型；完成响应后立即退出。报告生成进度和正文仍在投资分析页面查看。
