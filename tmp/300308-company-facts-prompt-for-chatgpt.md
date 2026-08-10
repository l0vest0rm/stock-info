# 300308.SZ：S1 公司事实 Prompt（用于 ChatGPT 网页版复现）

来源：本地 SQLite 中 `300308.SZ` 的 `company_facts` 子任务已完成尝试，run ID 为 `llm-run:a740eb5f-3d60-4a1a-b77e-856315fc6ffd`。它与随后失败的同一子任务使用同一输入指纹 `125bb86b4ecf26b7cd3aad670589820af83f939b748be381c5bf961d7bc2617c`。

注意：失败尝试在持久化时会把原始 prompt 覆盖为“阶段执行失败，未产生可用终态输出”，所以数据库没有留下失败请求的逐字副本。下面是同一任务、同一输入指纹中可恢复的完整拼装 prompt；不含 API key、请求 ID 和任何运行配置。

## 一次性粘贴到 ChatGPT 的完整文本

你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。

# S1：公司事实

你负责建立可追溯的公司事实域。只使用 `research_context` 中的公司/证券身份、报告边界、已登记来源和结构化快照，以及本阶段允许检索的公司正式披露、监管/交易所材料和管理层原话。必须区分公司事实、管理层表述、会计/治理事实和未知项；不得把公司自述变成行业事实或竞争结论。

禁止：行业周期与利润池、同行排名或优劣、财务质量评分、情景估值、目标价；不得重新抄录三表数值，结构化三表只引用输入中的 `financialSnapshot`。

只输出本域的完整 Markdown 正文，不要 JSON、YAML、代码围栏或元数据包。使用清晰的二级/三级标题覆盖公司身份与边界、产品/客户/地区/用途/分部、正式披露事实、管理层表述、会计与治理事实、已知缺口和未知项。每条事实都写明主体、期间、边界、单位、来源 URL 和限制；来源不足时明确写 `unknown` 或 `analysis gap`，不得猜测。保留冲突，不折中。

正文中的稳定 `sourceIds`、`evidenceIds`、`claimIds` 和 `unknownIds` 必须原样引用输入 manifest 中已有的 ID；不得用数组位置或章节位置伪造 ID。`usedUpstreamArtifactIds` 只允许引用 S0 artifact ID。正文应可直接进入第 2 章，不要输出第 1、3–12 章内容。

<input_data>
{
  "context": {
    "contextVersion": "research-context.v1",
    "researchTaskId": "research-operating-analysis-low-dependency:300308.SZ",
    "asOf": "2026-08-10T03:32:35.635Z",
    "company": {
      "companyId": null,
      "name": "中际旭创",
      "reportingCurrency": "CNY"
    },
    "security": {
      "securityId": null,
      "securityCode": "300308.SZ",
      "listingVenue": "SZ",
      "tradingCurrency": "CNY",
      "shareClass": null
    },
    "reportingBoundary": {
      "latestFiledPeriod": "2026-03-31",
      "latestAnnualPeriod": null,
      "laterProvisionalUpdates": []
    },
    "financialSnapshot": {
      "asOf": "2026-03-31",
      "schemaVersion": "operating-analysis-financial-snapshot.v1",
      "source": "系统结构化财务接口",
      "periods": ["2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"],
      "incomeStatement": [],
      "balanceSheet": [],
      "cashFlowStatement": [],
      "deterministicMetrics": [],
      "securityId": null,
      "securityCode": null,
      "listingVenue": null,
      "shareClass": null,
      "tradingCurrency": null,
      "sharesOutstanding": null,
      "rights": null,
      "historicalValuation": [],
      "price": null,
      "marketCapitalization": null,
      "currency": null,
      "reportedMultiples": {},
      "qualityIssues": []
    },
    "marketSnapshot": {
      "asOf": "2026-08-10",
      "schemaVersion": "market-snapshot.v1",
      "source": "xueqiu",
      "periods": [],
      "incomeStatement": [],
      "balanceSheet": [],
      "cashFlowStatement": [],
      "deterministicMetrics": [],
      "securityId": null,
      "securityCode": "300308.SZ",
      "listingVenue": "SZ",
      "shareClass": null,
      "tradingCurrency": "CNY",
      "sharesOutstanding": 0,
      "rights": null,
      "historicalValuation": [],
      "price": 850.5,
      "marketCapitalization": 9954.44179491,
      "currency": "CNY",
      "reportedMultiples": {
        "peTtm": 66.59,
        "pb": 26.57,
        "psTtm": 19.494753714833088,
        "pcfTtm": 82.2732797734398
      },
      "qualityIssues": []
    },
    "scopeEnvelope": null,
    "sourceRegistryId": "source-registry:eba0921897af8f76d2317252f3562e5d3f9a987d61f5b495cca2e19e2cd9f7d9",
    "knownSourceIds": [
      "source:3e6dcad499c93b052d93f35e61302c65f919a0e530ff57f1e3b5215658202ea0",
      "source:63a2b452d60c6dc8e75b10c439260748f037cdcf1ccf202756c7505bfdc5cdb9",
      "source:aa1a25bfae944d699b5e501b4a1e6f26b9532e175dae9312b2875eea31dd2850",
      "source:e7c633290817079cb438fed0ff70da2881db69cc13c4e6d1e108be6f4c966071"
    ],
    "sourceRegistry": {
      "registryVersion": "research-source-registry.v1",
      "sourceIds": [
        "source:3e6dcad499c93b052d93f35e61302c65f919a0e530ff57f1e3b5215658202ea0",
        "source:63a2b452d60c6dc8e75b10c439260748f037cdcf1ccf202756c7505bfdc5cdb9",
        "source:aa1a25bfae944d699b5e501b4a1e6f26b9532e175dae9312b2875eea31dd2850",
        "source:e7c633290817079cb438fed0ff70da2881db69cc13c4e6d1e108be6f4c966071"
      ],
      "sources": [
        {
          "sourceId": "source:3e6dcad499c93b052d93f35e61302c65f919a0e530ff57f1e3b5215658202ea0",
          "sourceVersion": "research-source-registry.v1",
          "url": "/api/company/overview?code=300308.SZ",
          "title": "中际旭创 行情快照（xueqiu）",
          "publishedAt": "2026-08-10",
          "subject": "中际旭创 (300308.SZ)",
          "role": "market_data",
          "retrievedAt": "2026-08-10T03:26:46.353Z",
          "contentFingerprint": "3513aab964496962b72faabf5ac92a07b17a71764c3d63e0b8228c5f87f9aaeb",
          "availabilityStatus": "available",
          "limitations": []
        },
        {
          "sourceId": "source:63a2b452d60c6dc8e75b10c439260748f037cdcf1ccf202756c7505bfdc5cdb9",
          "sourceVersion": "research-source-registry.v1",
          "url": "/api/finance/cashflow?code=300308.SZ&format=read-model",
          "title": "eastmoney 现金流量表（2026-03-31）",
          "publishedAt": "2026-03-31",
          "subject": "中际旭创 (300308.SZ)",
          "role": "structured_financial",
          "retrievedAt": "2026-08-09T03:51:14.602Z",
          "contentFingerprint": "eb09d2545ecba34ed7ad5612c3349dc12cc732b591615b6fa538df06c427c4b5",
          "availabilityStatus": "available",
          "limitations": ["法定核验来源：cninfo"]
        },
        {
          "sourceId": "source:aa1a25bfae944d699b5e501b4a1e6f26b9532e175dae9312b2875eea31dd2850",
          "sourceVersion": "research-source-registry.v1",
          "url": "/api/finance/income?code=300308.SZ&format=read-model",
          "title": "eastmoney 利润表（2026-03-31）",
          "publishedAt": "2026-03-31",
          "subject": "中际旭创 (300308.SZ)",
          "role": "structured_financial",
          "retrievedAt": "2026-08-09T03:51:19.134Z",
          "contentFingerprint": "9ca03554c6128971b17591cee0a0450098d5048a4c89b707a4696ad40a6c2da4",
          "availabilityStatus": "available",
          "limitations": ["法定核验来源：cninfo"]
        },
        {
          "sourceId": "source:e7c633290817079cb438fed0ff70da2881db69cc13c4e6d1e108be6f4c966071",
          "sourceVersion": "research-source-registry.v1",
          "url": "/api/finance/balance?code=300308.SZ&format=read-model",
          "title": "eastmoney 资产负债表（2026-03-31）",
          "publishedAt": "2026-03-31",
          "subject": "中际旭创 (300308.SZ)",
          "role": "structured_financial",
          "retrievedAt": "2026-08-09T03:51:16.333Z",
          "contentFingerprint": "3f98b5fa7fe7ba73cea82a6fb988508a3b4a6befee163889bc8f8bf4bbc6b7e0",
          "availabilityStatus": "available",
          "limitations": ["法定核验来源：cninfo"]
        }
      ]
    },
    "analysisGaps": [
      {
        "gapId": "analysis-gap:24412288",
        "code": "scope_envelope_unreliable",
        "field": "scopeEnvelope",
        "message": "未提供可验证的产品、客户、地区和用途边界；S2-S5 只能走 companyScope 最小依赖",
        "blocking": false
      }
    ],
    "quality": {"status": "partial", "gapCount": 1},
    "inputFingerprint": "125bb86b4ecf26b7cd3aad670589820af83f939b748be381c5bf961d7bc2617c"
  },
  "stage": {
    "key": "company_facts",
    "label": "S1 公司事实",
    "schemaVersion": "company-facts.v3",
    "outputKind": "markdown",
    "owner": "company_facts"
  },
  "financialSnapshot": {
    "asOf": "2026-03-31",
    "schemaVersion": "operating-analysis-financial-snapshot.v1",
    "source": "系统结构化财务接口",
    "periods": ["2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"],
    "incomeStatement": [],
    "balanceSheet": [],
    "cashFlowStatement": [],
    "deterministicMetrics": [],
    "securityId": null,
    "securityCode": null,
    "listingVenue": null,
    "shareClass": null,
    "tradingCurrency": null,
    "sharesOutstanding": null,
    "rights": null,
    "historicalValuation": [],
    "price": null,
    "marketCapitalization": null,
    "currency": null,
    "reportedMultiples": {},
    "qualityIssues": []
  },
  "scopeEnvelopeAvailable": false,
  "inputFingerprint": "125bb86b4ecf26b7cd3aad670589820af83f939b748be381c5bf961d7bc2617c",
  "routing": {
    "routingState": "confirmed",
    "industryTemplateId": "optical-transceiver-ai-interconnect.v1",
    "industryKey": "optical_transceiver_ai_interconnect",
    "industryLabel": "高速光模块与 AI 数据中心光互连",
    "companyScope": {
      "primaryBusiness": null,
      "products": [],
      "downstream": [],
      "industry": null,
      "regions": [],
      "segments": [],
      "basisSourceIds": [],
      "facts": []
    },
    "sourceIds": [
      "source:3e6dcad499c93b052d93f35e61302c65f919a0e530ff57f1e3b5215658202ea0",
      "source:63a2b452d60c6dc8e75b10c439260748f037cdcf1ccf202756c7505bfdc5cdb9",
      "source:aa1a25bfae944d699b5e501b4a1e6f26b9532e175dae9312b2875eea31dd2850",
      "source:e7c633290817079cb438fed0ff70da2881db69cc13c4e6d1e108be6f4c966071"
    ],
    "evidenceIds": [],
    "upstreamArtifactIds": [
      "llm-artifact:4e9e06a4-f8f4-48d0-b0a0-5f35e9c82cbc",
      "llm-artifact:bd80a42b-c309-4f1b-ac89-aa43c6bb3fea"
    ]
  }
}
</input_data>
