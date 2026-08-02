请分析下面的公司资讯，并严格输出 JSON：
{
  "isCompanyReport": true,
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

判定规则：
1. isCompanyReport 仅在正文明确转述或发布了某个券商、投行、研究机构、分析师对这家公司的研究结论时为 true。包括明确的投资评级、目标价、估值方法或年度业绩预测；媒体对研报的转述也算。
2. 普通业绩快讯、股价异动、技术面评论、公司公告、泛泛的“机构看好”，即使出现“目标价”但没有可归属的研究机构结论，也为 false。
3. 若为 false，forecasts 必须为 []，valuation 的所有字段必须为 null。
4. forecasts 只保留原文明确给出的未来年度预测；营收和净利润统一为亿元，增速为百分数数值，EPS/PE 保持数值。季度、历史实际业绩不能填入。
5. valuation.rating 保留明确评级文字，如“买入”“增持”“跑赢大盘”；targetPrice 只填单一明确目标价数值；targetPriceCurrency 使用“人民币”“港元”“美元”“欧元”等原文可确认的币种；targetPe 只填明确目标PE；valuationMethod 仅保留明确方法，如“PE”“PB”“DCF”，否则 null。
6. 一个字段没有明确证据时填 null，不能猜测；forecasts 按年份升序。

标题：{{TITLE}}

正文：
{{CONTENT}}
