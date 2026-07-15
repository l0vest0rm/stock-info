const YI = 100_000_000;

export function trimDate(value) {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

export function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function previousQuarterEndDate(asOf) {
  assertDate(asOf, "as-of");
  const [year, month] = asOf.split("-").map(Number);
  if (month <= 3) return `${year - 1}-12-31`;
  if (month <= 6) return `${year}-03-31`;
  if (month <= 9) return `${year}-06-30`;
  return `${year}-09-30`;
}

export function daysBefore(date, days) {
  assertDate(date, "date");
  const parsed = new Date(`${date}T12:00:00+08:00`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

export function aggregateEarningsEvents(performanceRows, forecastRows, { asOf, fromDate, reportDate }) {
  const eligible = (row) => {
    const noticeDate = trimDate(row.NOTICE_DATE ?? row.UPDATE_DATE);
    return trimDate(row.REPORT_DATE) === reportDate
      && noticeDate >= fromDate
      && noticeDate <= asOf;
  };

  const performanceByCode = new Map();
  for (const row of [...performanceRows].filter(eligible).sort(compareNewest)) {
    const code = normalizeCode(row.SECUCODE ?? row.SECURITY_CODE);
    if (!isAshare(code) || performanceByCode.has(code)) continue;
    performanceByCode.set(code, performanceEvent(code, row));
  }

  const latestForecastMetrics = new Map();
  for (const row of [...forecastRows].filter(eligible).sort(compareNewest)) {
    if (String(row.IS_LATEST ?? "T") === "F") continue;
    const code = normalizeCode(row.SECUCODE ?? row.SECURITY_CODE);
    const metric = String(row.PREDICT_FINANCE_CODE ?? "");
    if (!isAshare(code) || !["004", "005", "006"].includes(metric)) continue;
    const key = `${code}:${metric}`;
    if (!latestForecastMetrics.has(key)) latestForecastMetrics.set(key, row);
  }

  const forecastByCode = new Map();
  for (const row of latestForecastMetrics.values()) {
    const code = normalizeCode(row.SECUCODE ?? row.SECURITY_CODE);
    const current = forecastByCode.get(code) ?? forecastEvent(code, row);
    applyForecastMetric(current, row);
    if (trimDate(row.NOTICE_DATE) > current.noticeDate) current.noticeDate = trimDate(row.NOTICE_DATE);
    forecastByCode.set(code, current);
  }

  const codes = new Set([...performanceByCode.keys(), ...forecastByCode.keys()]);
  return [...codes].map((code) => performanceByCode.get(code) ?? forecastByCode.get(code));
}

export function attachMarketsAndFilter(events, marketRows, filters) {
  const markets = new Map(marketRows.map((row) => [normalizeCode(row.SECUCODE ?? row.SECURITY_CODE), row]));
  return events.flatMap((event) => {
    const market = markets.get(event.code);
    if (!market) return [];
    const marketCapYuan = numberValue(market.TOTAL_MARKET_CAP);
    if (marketCapYuan === null) return [];
    const marketCapYi = marketCapYuan / YI;
    if (marketCapYi < filters.minMarketCapYi || marketCapYi > filters.maxMarketCapYi) return [];
    const name = String(market.SECURITY_NAME_ABBR ?? event.name ?? event.code).trim();
    if (filters.excludeNamePatterns.some((pattern) => name.includes(pattern))) return [];
    return [{
      ...event,
      name,
      market: {
        tradeDate: trimDate(market.MAX_TRADE_DATE),
        price: numberValue(market.NEW_PRICE),
        marketCapYuan,
        marketCapYi: round(marketCapYi),
        peTtm: round(numberValue(market.PE9)),
        pbMrq: round(numberValue(market.PBNEWMRQ)),
        latestProfitYoY: round(numberValue(market.NETPROFIT_YOY_RATIO)),
        dividendYield: round(numberValue(market.ZXGXL)),
        institutionCount: numberValue(market.ALLCORP_NUM),
      },
    }];
  }).sort(comparePreAnalysisCandidates);
}

export function prioritizeEarningsEvents(events, limit) {
  return [...events].sort(compareCandidates).slice(0, limit);
}

export function analyzeCandidate(candidate, statements, { asOf, forecastYear, ranking }) {
  const incomeRows = eligibleStatements(statements.income ?? [], asOf);
  const balanceRows = eligibleStatements(statements.balance ?? [], asOf);
  const cashflowRows = eligibleStatements(statements.cashflow ?? [], asOf);
  const reportYear = Number(candidate.reportDate.slice(0, 4));
  const quarter = quarterNumber(candidate.reportDate);
  const previousYtd = completeQuarterSum(incomeRows, reportYear, quarter - 1, "parentNetprofit");
  const profitMid = midpoint(candidate.profit.lowYuan, candidate.profit.highYuan);
  const cumulativeYoYComparable = isMeaningfulComparisonBase(candidate.profit.previousYuan, profitMid, ranking.lowBaseRatio);
  const singleQuarter = previousYtd === null || profitMid === null ? null : profitMid - previousYtd;
  const previousYearQuarter = quarterRow(incomeRows, reportYear - 1, quarter);
  const priorQuarter = previousQuarterRow(incomeRows, reportYear, quarter);
  const priorYearQuarterProfit = statementValue(previousYearQuarter, "parentNetprofit", "PARENT_NETPROFIT");
  const priorQuarterProfit = statementValue(priorQuarter, "parentNetprofit", "PARENT_NETPROFIT");
  const seasonalityShares = historicalYtdShares(incomeRows, reportYear, quarter);
  const projection = projectAnnualProfit(candidate.profit, quarter);
  const marketCapYuan = candidate.market.marketCapYuan;
  const projectedPe = {
    bear: forwardPe(marketCapYuan, projection.bearYuan),
    base: forwardPe(marketCapYuan, projection.baseYuan),
    bull: forwardPe(marketCapYuan, projection.bullYuan),
  };
  const singleQuarterYoY = growthRate(singleQuarter, priorYearQuarterProfit);
  const singleQuarterQoQ = growthRate(singleQuarter, priorQuarterProfit);
  const growthSignal = effectiveGrowthSignal({
    qoq: singleQuarterQoQ,
    yoy: singleQuarterYoY,
    cumulativeYoYComparable,
  }, ranking);
  const pegGrowthUsed = growthSignal.value !== null && growthSignal.value > 0
    ? Math.min(growthSignal.value, ranking.growthCeiling)
    : null;
  const pegLike = projectedPe.base !== null && pegGrowthUsed !== null
    ? round(projectedPe.base / pegGrowthUsed)
    : null;

  const currentCashflow = completeQuarterSum(cashflowRows, reportYear, quarter, "netcashOperate");
  const latestBalance = latestStatementAtOrBefore(balanceRows, candidate.reportDate);
  const totalAssets = statementValue(latestBalance, "totaAssets", "TOTAL_ASSETS");
  const totalLiabilities = statementValue(latestBalance, "totalLiabilities", "TOTAL_LIABILITIES");
  const accountsReceivable = statementValue(latestBalance, "accountsRece", "ACCOUNTS_RECE");
  const inventory = statementValue(latestBalance, "inventory", "INVENTORY");

  const warnings = [];
  const eventRiskKeywords = ranking.riskReasonKeywords.filter((keyword) => candidate.reason.includes(keyword));
  if (singleQuarter === null) warnings.push("缺少完整前序季度，单季增速不可计算");
  if (!cumulativeYoYComparable) warnings.push("上年同期为亏损或低基数，累计同比仅作背景，不参与排序");
  if (singleQuarter !== null && priorYearQuarterProfit !== null && priorYearQuarterProfit <= 0) {
    warnings.push("上年同季利润非正，单季同比百分比不具可比性");
  }
  if (singleQuarter !== null && priorQuarterProfit !== null && priorQuarterProfit <= 0) {
    warnings.push("上一季度利润非正，单季环比百分比不具可比性");
  }
  if (growthSignal.yoyIgnoredReason) warnings.push(growthSignal.yoyIgnoredReason);
  if (eventRiskKeywords.length) warnings.push(`业绩原因包含${eventRiskKeywords.join("、")}，按非经常性或投资收益风险扣分`);
  if (candidate.sourceType === "performance_forecast" && rangeWidth(candidate.profit) > 0.5) {
    warnings.push("业绩预告区间较宽");
  }
  if (profitMid !== null && currentCashflow !== null && profitMid > 0 && currentCashflow / profitMid < 0.5) {
    warnings.push("经营现金流与利润匹配偏弱");
  }
  const deductMid = midpoint(candidate.deductProfit.lowYuan, candidate.deductProfit.highYuan);
  if (profitMid !== null && profitMid > 0 && deductMid !== null && deductMid / profitMid < 0.5) {
    warnings.push("扣非净利润明显低于归母净利润，需核查非经常性损益");
  }
  if (projection.bearYuan !== null && projection.bearYuan > 0 && projection.bullYuan / projection.bearYuan >= 3) {
    warnings.push("业绩披露区间较宽，年化利润和Forward PE跨度较大");
  }

  return {
    ...candidate,
    forecastYear,
    trends: {
      cumulativeProfitYoYLow: round(candidate.profit.yoyLow),
      cumulativeProfitYoYHigh: round(candidate.profit.yoyHigh),
      cumulativeProfitYoYComparable: cumulativeYoYComparable,
      previousCumulativeProfitYi: toYi(candidate.profit.previousYuan),
      singleQuarterProfitYi: toYi(singleQuarter),
      singleQuarterYoY,
      singleQuarterQoQ,
      effectiveGrowth: growthSignal.value,
      effectiveGrowthInputs: growthSignal.inputs,
    },
    projection: {
      method: projection.method,
      seasonalSampleCount: seasonalityShares.length,
      historicalYtdShareMedian: round(median(seasonalityShares) * 100),
      confidence: projectionConfidence(candidate.sourceType, rangeWidth(candidate.profit)),
      profitYi: {
        bear: toYi(projection.bearYuan),
        base: toYi(projection.baseYuan),
        bull: toYi(projection.bullYuan),
      },
      pe: projectedPe,
      pegLike,
      pegGrowthUsed,
    },
    quality: {
      operatingCashflowYi: toYi(currentCashflow),
      operatingCashflowToProfit: ratio(currentCashflow, profitMid),
      debtToAssets: ratio(totalLiabilities, totalAssets, 100),
      accountsReceivableYi: toYi(accountsReceivable),
      inventoryYi: toYi(inventory),
    },
    riskFlags: { eventRiskKeywords },
    consensus: null,
    warnings,
  };
}

export function rankAnalyzedCandidates(candidates, ranking) {
  return candidates
    .map((candidate) => ({ ...candidate, screening: screeningScore(candidate, ranking) }))
    .sort((left, right) => right.screening.score - left.screening.score
      || right.noticeDate.localeCompare(left.noticeDate));
}

export function attachConsensus(candidate, rows) {
  const forecast = Array.isArray(rows)
    ? rows.find((row) => Number(row.year) === candidate.forecastYear && numberValue(row.netProfit) !== null)
    : null;
  if (!forecast) return candidate;
  const netProfitYi = numberValue(forecast.netProfit);
  return {
    ...candidate,
    consensus: {
      netProfitYi: round(netProfitYi),
      pe: netProfitYi > 0 ? round(candidate.market.marketCapYi / netProfitYi) : null,
      aggregation: "最近研报正净利润的简单平均",
      sampleCount: null,
    },
  };
}

export function renderEvidenceMarkdown(payload) {
  const lines = [
    "# 业绩研究证据包",
    "",
    `- 数据截至：${payload.asOf}`,
    `- 报告期：${payload.reportDate}`,
    `- 最近窗口：${payload.fromDate} 至 ${payload.asOf}`,
    `- 候选数量：${payload.candidates.length}`,
    `- 未来公告过滤：${payload.stats.futureRowsExcluded} 条`,
    `- 说明：候选顺序仅用于控制数据量，不代表最终推荐顺序。`,
    "",
    "## 候选总表",
    "",
    "| 公司 | 来源 | 公告日 | 单季环比 | 有效增速 | 累计同比口径 | 年化利润(亿) | Forward PE | PE/有效增速 | 综合分 |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const item of payload.candidates) {
    lines.push(`| ${item.name}（${item.code}） | ${sourceLabel(item.sourceType)} | ${item.noticeDate} | ${formatPercent(item.trends.singleQuarterQoQ)} | ${formatPercent(item.trends.effectiveGrowth)} | ${formatYoYContext(item)} | ${formatScenario(item.projection.profitYi)} | ${formatScenario(item.projection.pe)} | ${formatNumber(item.projection.pegLike)} | ${formatNumber(item.screening?.score)} |`);
  }
  for (const item of payload.candidates) {
    lines.push(
      "",
      `## ${item.name}（${item.code}）`,
      "",
      `- 披露：${item.noticeDate} ${sourceLabel(item.sourceType)}，报告期 ${item.reportDate}`,
      `- 归母净利润：${formatRangeYi(item.profit)} 亿元；累计同比 ${formatPercentRange(item.trends.cumulativeProfitYoYLow, item.trends.cumulativeProfitYoYHigh)}（${item.trends.cumulativeProfitYoYComparable ? "比较基数有效" : "低基数或扭亏，仅作背景"}）`,
      `- 扣非净利润：${formatRangeYi(item.deductProfit)} 亿元`,
      `- 营业收入：${formatRangeYi(item.revenue)} 亿元`,
      `- 单季净利润：${formatNumber(item.trends.singleQuarterProfitYi)} 亿元；同比 ${formatPercent(item.trends.singleQuarterYoY)}；环比 ${formatPercent(item.trends.singleQuarterQoQ)}`,
      `- 有效增速：${formatPercent(item.trends.effectiveGrowth)}；输入 ${formatGrowthInputs(item.trends.effectiveGrowthInputs)}；PEG-like采用增速上限 ${formatPercent(item.projection.pegGrowthUsed)}；PE/有效增速 ${formatNumber(item.projection.pegLike)}`,
      `- 市值：${formatNumber(item.market.marketCapYi)} 亿元；TTM PE ${formatNumber(item.market.peTtm)}；PB ${formatNumber(item.market.pbMrq)}；股息率 ${formatPercent(item.market.dividendYield)}`,
      `- 年化利润（悲观/基准/乐观）：${formatScenario(item.projection.profitYi)} 亿元`,
      `- Forward PE（悲观/基准/乐观）：${formatScenario(item.projection.pe)}`,
      `- 推演方法：${item.projection.method}；历史季节性样本 ${item.projection.seasonalSampleCount}；置信度 ${confidenceLabel(item.projection.confidence)}`,
      `- 综合筛选分：${formatNumber(item.screening?.score)}；分项 ${formatScreeningComponents(item.screening?.components)}；扣分 ${formatScreeningPenalties(item.screening?.penalties)}`,
      `- 经营现金流：${formatNumber(item.quality.operatingCashflowYi)} 亿元；现金流/利润 ${formatRatio(item.quality.operatingCashflowToProfit)}；资产负债率 ${formatPercent(item.quality.debtToAssets)}`,
      `- 应收账款：${formatNumber(item.quality.accountsReceivableYi)} 亿元；存货：${formatNumber(item.quality.inventoryYi)} 亿元`,
      `- 研报预测：${item.consensus ? `${item.consensus.netProfitYi} 亿元，对应 PE ${formatNumber(item.consensus.pe)}；口径为${item.consensus.aggregation}，样本数未知` : "本次未获取或无有效数据"}`,
      `- 预告类型：${item.forecastType || "-"}`,
      `- 变动原因：${item.reason || "未提供"}`,
      `- 风险提示：${item.warnings.length ? item.warnings.join("；") : "未触发规则型风险提示，仍需阅读公告原文"}`,
      `- 数据链接：[财务数据](${payload.baseUrl}/api/finance/income?code=${encodeURIComponent(item.code)})${item.consensus ? `；[研报预测](${payload.baseUrl}/api/report/forecast?code=${encodeURIComponent(item.code)})` : ""}`,
    );
  }
  lines.push(
    "",
    "## 口径与限制",
    "",
    "- 预告金额保留上下限；基准值取区间中点。",
    "- 年化利润使用最新累计披露的运行率：一季度×4、半年×2、前三季度×4/3、全年直接采用。历史季节性仅作为风险参考。",
    "- 有效增速以单季环比为主；同比在扭亏、低基数或绝对值超过配置阈值时退出评分。",
    "- PE/有效增速是 PEG-like 辅助指标，不等同于基于长期复合增长率的标准 PEG。",
    "- PE 使用行情接口返回的人民币总市值除以推演归母净利润，未使用存在单位歧义的 company overview marketCapYi。",
    "- 研报预测接口目前只返回正净利润简单平均，不提供机构数、中位数或分歧度。",
    "- 当前接口不支持完整历史 as-of 回放，本证据包适合当前研究，不代表严格无前视回测。",
    "",
  );
  return lines.join("\n");
}

export function renderPrompt(template, { asOf, reportDate, evidencePath, outputPath, evidence }) {
  return template
    .replaceAll("{{AS_OF}}", asOf)
    .replaceAll("{{REPORT_DATE}}", reportDate)
    .replaceAll("{{EVIDENCE_PATH}}", evidencePath)
    .replaceAll("{{OUTPUT_PATH}}", outputPath)
    .replaceAll("{{EVIDENCE}}", evidence);
}

function performanceEvent(code, row) {
  const profit = numberValue(row.PARENT_NETPROFIT);
  const revenue = numberValue(row.TOTAL_OPERATE_INCOME);
  return {
    code,
    name: String(row.SECURITY_NAME_ABBR ?? code),
    reportDate: trimDate(row.REPORT_DATE),
    noticeDate: trimDate(row.NOTICE_DATE ?? row.UPDATE_DATE),
    sourceType: "performance_report",
    forecastType: "业绩快报",
    profit: range(profit, profit, row.JLRTBZCL, row.JLRTBZCL, row.PARENT_NETPROFIT_SQ),
    deductProfit: emptyRange(),
    revenue: range(revenue, revenue, row.YSTZ, row.YSTZ),
    reason: "",
  };
}

function forecastEvent(code, row) {
  return {
    code,
    name: String(row.SECURITY_NAME_ABBR ?? code),
    reportDate: trimDate(row.REPORT_DATE),
    noticeDate: trimDate(row.NOTICE_DATE),
    sourceType: "performance_forecast",
    forecastType: String(row.PREDICT_TYPE ?? "业绩预告"),
    profit: emptyRange(),
    deductProfit: emptyRange(),
    revenue: emptyRange(),
    reason: String(row.CHANGE_REASON_EXPLAIN ?? row.PREDICT_CONTENT ?? "").trim(),
  };
}

function applyForecastMetric(event, row) {
  const metric = String(row.PREDICT_FINANCE_CODE ?? "");
  const value = range(
    numberValue(row.PREDICT_AMT_LOWER),
    numberValue(row.PREDICT_AMT_UPPER),
    numberValue(row.ADD_AMP_LOWER),
    numberValue(row.ADD_AMP_UPPER),
    numberValue(row.PREYEAR_SAME_PERIOD),
  );
  if (metric === "004") event.profit = value;
  if (metric === "005") event.deductProfit = value;
  if (metric === "006") event.revenue = value;
}

function range(low, high, yoyLow = null, yoyHigh = null, previous = null) {
  const values = [numberValue(low), numberValue(high)].filter((value) => value !== null).sort((a, b) => a - b);
  const yoyValues = [numberValue(yoyLow), numberValue(yoyHigh)].filter((value) => value !== null).sort((a, b) => a - b);
  return {
    lowYuan: values[0] ?? null,
    highYuan: values.at(-1) ?? null,
    yoyLow: yoyValues[0] ?? null,
    yoyHigh: yoyValues.at(-1) ?? null,
    previousYuan: numberValue(previous),
  };
}

function emptyRange() {
  return range(null, null, null, null);
}

function compareNewest(left, right) {
  return `${trimDate(right.NOTICE_DATE)}:${trimDate(right.UPDATE_DATE)}`.localeCompare(`${trimDate(left.NOTICE_DATE)}:${trimDate(left.UPDATE_DATE)}`);
}

function compareCandidates(left, right) {
  const date = right.noticeDate.localeCompare(left.noticeDate);
  if (date !== 0) return date;
  const rightGrowth = midpoint(right.profit.yoyLow, right.profit.yoyHigh) ?? -Infinity;
  const leftGrowth = midpoint(left.profit.yoyLow, left.profit.yoyHigh) ?? -Infinity;
  return rightGrowth - leftGrowth;
}

function comparePreAnalysisCandidates(left, right) {
  const score = preAnalysisScore(right) - preAnalysisScore(left);
  return score || right.noticeDate.localeCompare(left.noticeDate);
}

function preAnalysisScore(candidate) {
  const growth = midpoint(candidate.profit.yoyLow, candidate.profit.yoyHigh);
  const cappedGrowth = growth === null ? 0 : clamp(growth, -50, 100) / 10;
  const pe = candidate.market?.peTtm;
  const valuation = pe > 0 ? clamp((50 - pe) / 5, 0, 10) : 0;
  const profitMid = midpoint(candidate.profit.lowYuan, candidate.profit.highYuan);
  const deductMid = midpoint(candidate.deductProfit.lowYuan, candidate.deductProfit.highYuan);
  const deductQuality = profitMid > 0 && deductMid !== null ? clamp(deductMid / profitMid, 0, 1) * 10 : 3;
  return cappedGrowth + valuation + deductQuality + (candidate.sourceType === "performance_report" ? 3 : 0);
}

function screeningScore(candidate, ranking) {
  const weights = ranking.weights;
  const forwardPe = candidate.projection.pe.base;
  const peNormalized = forwardPe > 0 ? clamp((ranking.forwardPeCeiling - forwardPe) / ranking.forwardPeCeiling, 0, 1) : 0;
  const effectiveGrowth = candidate.trends.effectiveGrowth;
  const growthNormalized = effectiveGrowth === null ? 0 : normalize(effectiveGrowth, ranking.growthFloor, ranking.growthCeiling);
  const pegLike = candidate.projection.pegLike;
  const pegNormalized = pegLike !== null && pegLike >= 0
    ? clamp((ranking.pegLikeCeiling - pegLike) / ranking.pegLikeCeiling, 0, 1)
    : 0;
  const profitMid = midpoint(candidate.profit.lowYuan, candidate.profit.highYuan);
  const deductMid = midpoint(candidate.deductProfit.lowYuan, candidate.deductProfit.highYuan);
  const deductNormalized = profitMid > 0 && deductMid !== null ? clamp(deductMid / profitMid, 0, 1) : 0.4;
  const components = {
    forwardPe: round(peNormalized * weights.forwardPe),
    effectiveGrowth: round(growthNormalized * weights.effectiveGrowth),
    pegLike: round(pegNormalized * weights.pegLike),
    deductProfitQuality: round(deductNormalized * weights.deductProfitQuality),
  };
  const negativeSingleQuarterPenalty = candidate.trends.singleQuarterProfitYi !== null
    && candidate.trends.singleQuarterProfitYi <= 0
    ? ranking.negativeSingleQuarterPenalty
    : 0;
  const eventRiskPenalty = candidate.riskFlags?.eventRiskKeywords?.length ? ranking.eventRiskPenalty : 0;
  return {
    score: round(Object.values(components).reduce((sum, value) => sum + value, 0) - negativeSingleQuarterPenalty - eventRiskPenalty),
    components,
    penalties: { negativeSingleQuarter: negativeSingleQuarterPenalty, eventRisk: eventRiskPenalty },
  };
}

function isMeaningfulComparisonBase(previous, current, lowBaseRatio) {
  return previous !== null && current !== null && previous > 0 && current > 0 && previous / current >= lowBaseRatio;
}

function effectiveGrowthSignal({ qoq, yoy, cumulativeYoYComparable }, ranking) {
  const yoyUsable = cumulativeYoYComparable
    && yoy !== null
    && Math.abs(yoy) <= ranking.yoyIgnoreAbove;
  let yoyIgnoredReason = null;
  if (!cumulativeYoYComparable) {
    yoyIgnoredReason = "同比属于扭亏或低基数，不参与有效增速和候选排序";
  } else if (yoy !== null && Math.abs(yoy) > ranking.yoyIgnoreAbove) {
    yoyIgnoredReason = `单季同比绝对值超过${ranking.yoyIgnoreAbove}%，按异常高增速忽略`;
  }
  if (qoq !== null && yoyUsable) {
    return {
      value: round(qoq * ranking.effectiveGrowthWeights.qoq + yoy * ranking.effectiveGrowthWeights.yoy),
      inputs: { qoq, yoy, qoqWeight: ranking.effectiveGrowthWeights.qoq, yoyWeight: ranking.effectiveGrowthWeights.yoy },
      yoyIgnoredReason,
    };
  }
  if (qoq !== null) return { value: qoq, inputs: { qoq, yoy: null, qoqWeight: 1, yoyWeight: 0 }, yoyIgnoredReason };
  if (yoyUsable) return { value: yoy, inputs: { qoq: null, yoy, qoqWeight: 0, yoyWeight: 1 }, yoyIgnoredReason };
  return { value: null, inputs: { qoq: null, yoy: null, qoqWeight: 0, yoyWeight: 0 }, yoyIgnoredReason };
}

function normalize(value, floor, ceiling) {
  return clamp((value - floor) / (ceiling - floor), 0, 1);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeCode(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (text.includes(".")) return text;
  if (/^(0|1|2|3)/.test(text)) return `${text}.SZ`;
  if (/^(4|8)/.test(text)) return `${text}.BJ`;
  return text ? `${text}.SH` : "";
}

function isAshare(code) {
  return /^(60|68)\d{4}\.SH$/.test(code)
    || /^(00|30)\d{4}\.SZ$/.test(code)
    || /^[489]\d{5}\.BJ$/.test(code);
}

function eligibleStatements(rows, asOf) {
  return rows.filter((row) => {
    const reportDate = trimDate(row.reportDate ?? row.REPORT_DATE);
    const noticeDate = trimDate(row.noticeDate ?? row.NOTICE_DATE) || reportDate;
    return reportDate && reportDate <= asOf && noticeDate <= asOf;
  });
}

function quarterNumber(date) {
  const month = Number(date.slice(5, 7));
  if (month === 3) return 1;
  if (month === 6) return 2;
  if (month === 9) return 3;
  if (month === 12) return 4;
  throw new Error(`unsupported report date: ${date}`);
}

function rowQuarter(row) {
  return quarterNumber(trimDate(row.reportDate ?? row.REPORT_DATE));
}

function rowYear(row) {
  return Number(trimDate(row.reportDate ?? row.REPORT_DATE).slice(0, 4));
}

function quarterRow(rows, year, quarter) {
  return rows.find((row) => rowYear(row) === year && rowQuarter(row) === quarter) ?? null;
}

function previousQuarterRow(rows, year, quarter) {
  return quarter > 1 ? quarterRow(rows, year, quarter - 1) : quarterRow(rows, year - 1, 4);
}

function completeQuarterSum(rows, year, throughQuarter, mappedKey) {
  if (throughQuarter <= 0) return 0;
  let sum = 0;
  for (let quarter = 1; quarter <= throughQuarter; quarter += 1) {
    const value = statementValue(quarterRow(rows, year, quarter), mappedKey, uppercaseKey(mappedKey));
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

function uppercaseKey(mappedKey) {
  if (mappedKey === "parentNetprofit") return "PARENT_NETPROFIT";
  if (mappedKey === "netcashOperate") return "NETCASH_OPERATE";
  return mappedKey;
}

function statementValue(row, mappedKey, rawKey) {
  if (!row) return null;
  return numberValue(row[mappedKey] ?? row[rawKey]);
}

function historicalYtdShares(rows, currentYear, quarter) {
  if (quarter === 4) return [1];
  const result = [];
  for (let year = currentYear - 1; year >= currentYear - 4; year -= 1) {
    const annual = completeQuarterSum(rows, year, 4, "parentNetprofit");
    const ytd = completeQuarterSum(rows, year, quarter, "parentNetprofit");
    if (annual === null || ytd === null || annual <= 0 || ytd <= 0) continue;
    const share = ytd / annual;
    if (share >= 0.05 && share <= 1.5) result.push(share);
  }
  return result;
}

function projectAnnualProfit(profit, quarter) {
  const low = profit.lowYuan;
  const high = profit.highYuan;
  const mid = midpoint(low, high);
  if (mid === null) return { bearYuan: null, baseYuan: null, bullYuan: null, method: "缺少归母净利润，无法推演" };
  const annualizationFactor = 4 / quarter;
  return {
    bearYuan: (low ?? mid) * annualizationFactor,
    baseYuan: mid * annualizationFactor,
    bullYuan: (high ?? mid) * annualizationFactor,
    method: quarter === 4 ? "年度数据直接采用" : `${quarterLabel(quarter)}累计利润按运行率×${formatFactor(annualizationFactor)}年化`,
  };
}

function projectionConfidence(sourceType, profitRangeWidth) {
  if (sourceType === "performance_report") return "high";
  return profitRangeWidth <= 0.3 ? "medium" : "low";
}

function quarterLabel(quarter) {
  if (quarter === 1) return "一季度";
  if (quarter === 2) return "半年";
  if (quarter === 3) return "前三季度";
  return "全年";
}

function formatFactor(value) {
  return Number.isInteger(value) ? String(value) : String(round(value, 2));
}

function forwardPe(marketCapYuan, profitYuan) {
  return profitYuan !== null && profitYuan > 0 ? round(marketCapYuan / profitYuan) : null;
}

function growthRate(current, previous) {
  if (current === null || previous === null || previous <= 0) return null;
  return round((current / previous - 1) * 100);
}

function latestStatementAtOrBefore(rows, reportDate) {
  return rows
    .filter((row) => trimDate(row.reportDate ?? row.REPORT_DATE) <= reportDate)
    .sort((a, b) => trimDate(b.reportDate ?? b.REPORT_DATE).localeCompare(trimDate(a.reportDate ?? a.REPORT_DATE)))[0] ?? null;
}

function midpoint(low, high) {
  if (low === null && high === null) return null;
  if (low === null) return high;
  if (high === null) return low;
  return (low + high) / 2;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function ratio(numerator, denominator, scale = 1) {
  return numerator !== null && denominator !== null && denominator !== 0 ? round((numerator / denominator) * scale) : null;
}

function rangeWidth(value) {
  const mid = midpoint(value.lowYuan, value.highYuan);
  if (mid === null || mid === 0 || value.lowYuan === null || value.highYuan === null) return 0;
  return Math.abs(value.highYuan - value.lowYuan) / Math.abs(mid);
}

function toYi(value) {
  return value === null ? null : round(value / YI);
}

function formatRangeYi(value) {
  const low = toYi(value.lowYuan);
  const high = toYi(value.highYuan);
  if (low === null && high === null) return "-";
  if (low === high || high === null) return formatNumber(low);
  if (low === null) return formatNumber(high);
  return `${formatNumber(low)}～${formatNumber(high)}`;
}

function formatPercentRange(low, high) {
  if (low === null && high === null) return "-";
  if (low === high || high === null) return formatPercent(low);
  if (low === null) return formatPercent(high);
  return `${formatNumber(low)}%～${formatNumber(high)}%`;
}

function formatScenario(value) {
  return `${formatNumber(value.bear)} / ${formatNumber(value.base)} / ${formatNumber(value.bull)}`;
}

function formatYoYContext(item) {
  const value = formatPercentRange(item.trends.cumulativeProfitYoYLow, item.trends.cumulativeProfitYoYHigh);
  return item.trends.cumulativeProfitYoYComparable ? value : `${value}（低基数）`;
}

function formatScreeningComponents(components) {
  if (!components) return "-";
  return `Forward PE ${formatNumber(components.forwardPe)}、有效增速 ${formatNumber(components.effectiveGrowth)}、PE/增速 ${formatNumber(components.pegLike)}、扣非质量 ${formatNumber(components.deductProfitQuality)}`;
}

function formatScreeningPenalties(penalties) {
  if (!penalties) return "-";
  return `单季亏损 ${formatNumber(penalties.negativeSingleQuarter)}、非经常性/投资收益 ${formatNumber(penalties.eventRisk)}`;
}

function formatGrowthInputs(inputs) {
  if (!inputs || (inputs.qoq === null && inputs.yoy === null)) return "不可计算";
  const parts = [];
  if (inputs.qoq !== null) parts.push(`环比${formatPercent(inputs.qoq)}×${inputs.qoqWeight}`);
  if (inputs.yoy !== null) parts.push(`同比${formatPercent(inputs.yoy)}×${inputs.yoyWeight}`);
  return parts.join(" + ");
}

function formatPercent(value) {
  return value === null || value === undefined ? "-" : `${formatNumber(value)}%`;
}

function formatNumber(value) {
  return value === null || value === undefined ? "-" : String(round(value));
}

function formatRatio(value) {
  return value === null ? "-" : `${formatNumber(value)}x`;
}

function sourceLabel(value) {
  return value === "performance_report" ? "业绩快报" : "业绩预告";
}

function confidenceLabel(value) {
  if (value === "high") return "高";
  if (value === "medium") return "中";
  return "低";
}

function assertDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
}
