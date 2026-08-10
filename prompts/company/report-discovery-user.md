# 公司近期研报发现

- 证券代码：{{SECURITY_CODE}}
- 公司名称：{{COMPANY_NAME}}
- 搜索起始日期：{{RECENT_SINCE}}

请用 Web Search 查找该公司自起始日期以来的公开研报，并返回可核验的候选。每条报告使用下面的 JSON 结构；字段没有可靠证据时填 `null`，没有明确年度预测时 `forecasts` 返回空数组。

```json
{
  "reports": [
    {
      "title": "报告标题",
      "institution": "研究机构",
      "publishedAt": "2026-06-20",
      "url": "https://public.example/report",
      "forecasts": [
        {
          "year": 2026,
          "revenue": 123.4,
          "revenueGrowth": 12.5,
          "netProfit": 10.2,
          "profitGrowth": 15,
          "eps": 1.2,
          "pe": 20
        }
      ],
      "valuation": {
        "rating": "买入",
        "targetPrice": 18.5,
        "targetPriceCurrency": "人民币",
        "targetPe": 20,
        "valuationMethod": "PE"
      }
    }
  ]
}
```

只提取搜索证据明确支持的内容；营收和净利润用亿元，增速用百分数数值，不能推测或拼接数字。URL 必须是有效的 `http(s)` 来源。只输出 JSON，不要 Markdown、解释或工程去重字段。
