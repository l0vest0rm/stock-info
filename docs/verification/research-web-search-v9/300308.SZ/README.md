# 300308.SZ：按来源包 Web Search 模板实测与调优

验证日期：2026-08-07。所有调用均使用 `gpt-5.6-luna`、`reasoning.effort=high`、`web_search` required、`search_context_size=high`。每份 JSON 保存完整有效 Prompt、搜索查询、原生引文、完整模型返回和计时，不是人工摘要。

## 设计结论

- 一次搜索按可复用的**来源包**而非单一字段执行：最新年报、近期披露、行业市场、同行竞争、事件风险；同一个包产出的证据同时供对应 Tab 读取。
- 只有最新年报和近期披露包传入本地法定财报 URL。行业、同行、外部预测补充和事件风险不注入该链接；行业包实测改用公司 IR 与行业机构原文。
- 项目内研报预测账本是预测页主源。`forecast_consensus` 仅是用户显式点击的外部预测补充包，并先由工程查询注入内部已覆盖的指标/期间，禁止重复搜索或声称“市场一致预期”。本次未对它做常规 Web Search 调用。
- 去重键已从全局版本改成 `security_code + package_kind + package_prompt_version`。因此单独调优年报/行业模板不会令近期披露、同行或风险包失效重搜。

## v8：五个主要来源包真实调用

| 包 | 总耗时 | 首个文本 | 查询 | 引文 | 记录 | verified | unavailable | 无效 Tab |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 最新年报 | 253.656 秒 | 153.865 秒 | 9 | 8 | 25 | 21 | 4 | 3 |
| 近期披露 | 248.644 秒 | 188.351 秒 | 12 | 4 | 10 | 10 | 0 | 0 |
| 行业市场 | 203.561 秒 | 104.147 秒 | 4 | 7 | 23 | 20 | 3 | 0 |
| 同行竞争 | 262.700 秒 | 151.820 秒 | 3 | 4 | 25 | 22 | 3 | 0 |
| 事件风险 | 161.740 秒 | 122.356 秒 | 12 | 3 | 3 | 3 | 0 | 0 |

原始结果：

- [latest_annual_report.json](../../research-web-search-v8/300308.SZ/latest_annual_report.json)
- [recent_filings.json](../../research-web-search-v8/300308.SZ/recent_filings.json)
- [industry_market.json](../../research-web-search-v8/300308.SZ/industry_market.json)
- [peer_set.json](../../research-web-search-v8/300308.SZ/peer_set.json)
- [event_risk.json](../../research-web-search-v8/300308.SZ/event_risk.json)

观察：年报包正确识别 `2026-04-17` 是 2026Q1、最新年度披露是 2025 年报；近期披露包仅返回年报边界后的质押、1260H、H 股备案和传闻澄清；行业包没有财报链接仍找到了公司 IR、LightCounting 与 Ethernet Alliance 原文；同行包仅建立产品边界重叠的功能可比关系，不生成份额/排名；事件风险包保持公司原文、监管事件及后续触发器的区分。

## 从实测得到的两项调优与复测

1. 年报包有 3 条治理事实错误写入不存在的 `governance` Tab，运行时会拒绝。模板增加 Tab 映射：董事会、审计、独立董事、关联交易、资本配置等必须写 `financial`。
2. 行业包曾把“某数据库覆盖出货量”的目录描述标为 `verified`。模板现在规定：没有实际数值、期间和边界时必须写 `unavailable`。

| 复测包 | 总耗时 | 首个文本 | 查询 | 引文 | 记录 | verified | unavailable | 无效 Tab | 结果 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 最新年报 v2 | 292.809 秒 | 129.651 秒 | 2 | 3 | 37 | 36 | 1 | 0 | `governance` 越界归零 |
| 行业市场 v2 | 228.010 秒 | 122.209 秒 | 3 | 7 | 28 | 22 | 6 | 0 | 不再把目录覆盖描述写为出货量事实 |

复测原始结果：

- [latest_annual_report.json](latest_annual_report.json)
- [industry_market.json](industry_market.json)

以上结果仍是来源绑定输入，不是市场份额、TAM/SAM/SOM、公司预测或投资结论；产品、地区、期间、收入/出货口径不一致时保留 `unavailable` 或可比性阻断，交由工程层确定性计算。
