# 公司近期研报发现

## 研究对象

- 证券代码：{{SECURITY_CODE}}
- 公司名称：{{COMPANY_NAME}}
- 搜索起始日期：{{RECENT_SINCE}}
- 最多返回报告数：{{MAX_REPORTS}}

请使用 Web Search，发现该公司自搜索起始日期以来近期公开可访问的研究报告。不要复述或重新解析当前页面已有研报；本次输入不包含已有研报列表、PDF 或 HTML 正文。

只输出严格 JSON，不要 Markdown 或解释：

```json
{
  "reports": [
    {
      "title": "报告标题",
      "institution": "研究机构",
      "publishedAt": "2026-06-20",
      "url": "https://public.example/report.pdf",
      "forecasts": [
        {
          "year": 2026,
          "revenue": null,
          "revenueGrowth": null,
          "netProfit": null,
          "profitGrowth": null,
          "eps": null,
          "pe": null
        }
      ],
      "valuation": {
        "rating": null,
        "targetPrice": null,
        "targetPriceCurrency": null,
        "targetPe": null,
        "valuationMethod": null
      }
    }
  ]
}
```

规则：

1. 每篇候选必须明确属于该公司，并且标题、机构、发布日期、URL 四项都能从公开原文或报告页面确认。
2. URL 必须是公开可打开的原文/报告页面，并且出现在本次 Web Search 的 citation 中；不要自造或只返回搜索结果页链接。
3. `forecasts` 只保留原文明确给出的全年/年度预测，按年份升序；`revenue`/`netProfit` 使用亿元，增速使用百分数数值，字段不明确返回 null。没有明确预测时返回空数组。
4. `valuation` 只填原文明确的评级、目标价、目标价币种、目标 PE 和估值方法；没有就返回 null。
5. 不判断候选是否重复、是否新增、是否保留或删除，不输出任何工程去重字段。
