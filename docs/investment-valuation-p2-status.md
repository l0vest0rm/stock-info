# 投资观察池估值体系：P2 完成状态

> 更新日期：2026-10-28。此前（2026-10-27）本文档记录的是「代码已写、环境阻塞、数据未生效」的状态；
> 本轮已在可执行的本地 Node 运行时上全部验证并回写数据。保留的只有真实代码层缺陷与根因。

## 结论

| 项 | 结果 | 验证方式 |
| --- | --- | --- |
| 观察池一手证据 | **97/98 家公司已核验**，115 条一手记录 | `config/investment-universe.json` |
| 证券级覆盖 | **115/116 collected** | `npm run check:all` + `GET /api/research/evidence/:code` |
| 研究分级 | **L1 40 / L2 35 / L3 23** | `researchPriority` + `researchBasis` |
| 任一证券缺口 | SK 海力士（结构性，见下） | `no_documents` |

**一句话：P2 的数据层已完成。剩下的是 P3（把估值区间接进每日流程）。**

## 本轮发现并修复的真实缺陷

### 1. 非首选上市代码一律落到 `other`

`companyValuationArchetype()` 原先只匹配 `preferredTicker`，后果不是小问题：

- `601398.SH` / `000001.SZ` 返回 `archetype: "other"`，`ev_ebit` / `ev_ebitda` 变成 `insufficient_data` 而不是 `forbidden_for_archetype`；
- `GET /api/research/comparability?code=600036.SH&peers=601398.SH,000001.SZ` 把两家银行判成「业务模型不同」，**可比矩阵把同一行业全部拒绝**；
- 同一家公司的 A/H 或 A/ADR 第二条线同样落到 `other`，于是银行拿到 EV/EBITDA、保险拿到未调整 PB。

已修复为按**发行人**解析（覆盖所有上市线），但仍要求代码确实在观察池内：未上市代码返回 `null` / `other`，不会被「猜」成某家公司。

**验收**：`600036.SH` 与 `03968.HK` 均解析为 `bank`；`601398.SH`（不在池内）返回 `other`。自检断言每个 `securities[].ticker` 必须解析回同一 `companyId`。

### 2. SEC 永远取不到定期报告

`indexSecFilings` 只读 `filings.recent`，而 SEC 只把最近约 1000 条申报放进这个数组，更早年份在 `filings.files[]` 指向的分年文件里。对 NVIDIA / Apple 这类申报频繁的公司，最近一份 10-K 早已被挤出 `recent`，「每年都交年报」的公司被判成 `no_documents`。

修复：新增 `loadSecFilingIndex()` 合并 `filings.files[]` 的分年文件（单独 cache key `sec.submissions.v1.{cik}.{name}`，单文件失败不拖垮已成功的索引）。同一索引也是 XBRL 事实回溯申报记录的来源指针。

**验收**：NVDA / AAPL / MSFT / GOOGL / ASML / TSM 全部从 `no_documents` 变为 `collected`，`identityVerified=true`。

### 3. 巨潮 A 股大面积 `no_documents`（三个叠加 bug）

不是「取不到数据」，是取数范围错了：

1. **只翻公告流第一页。** 原代码取 `page 1, pageSize 50`，而公告总量 847–3,628 条。宁德时代第一页 30 条全是「H股公告（翌日披露报表）」「回购进展」，半年报排在几千条之外。
2. **标题正则漏匹配。** 正则 `第[一二三四]季度报告` 要求带「第」字，巨潮实际标题是 `2026年三季度报告`。宁德时代第一页其实**就有**这份报告，却被判成 MISS。
3. **类别后缀猜错。** 沪深分别用 `_sh` / `_sz` 时巨潮**不报错**，而是静默返回全量公告流；实测只有 `_szsh`（深沪合写）生效：

   | category | total | 结果 |
   |---|---|---|
   | `category_sjdbg_szsh` | 9 | ✅ `2026年三季度报告` |
   | `category_sjdbg_sh` | 1797 | ❌ 回落到公告流 |
   | `category_sjdbg_sz` | 1797 | ❌ 回落到公告流 |

**改法**：弃用「翻页 + 标题正则」，改为按巨潮自己的 4 个定期报告类别直接查询（`fetchCninfoPeriodicReports()`）。并发改串行 + 退避重试——该接口每约 45 秒随机返回 403，而 POST 在 HTTP 层被判为不可重试，一次瞬时拒绝就会变成看起来像「这家公司没有报告」的永久失败。

### 4. 美股证据全部被丢弃

证据端点返回的记录代码是规范化后的 `NVDA.US`，观察池登记的是交易所原生符号 `NVDA`，脚本按 `record.security === security.ticker` 等值过滤，美股 358 条 SEC 记录一条都没写进观察池。

这里有个陷阱：观察池**不能**改成 `NVDA.US`——`validate-investment-universe.mjs` 明确要求美股为 `^[A-Z]{1,8}$` 裸代码，而 `isSupportedCompanyCode()` 只认带 `.US` 的形式。两边规范是刻意不同的（观察池存交易所原生符号，内部 API 存规范代码），所以正确修法是**写入前把记录重新绑定到观察池登记的那个符号**。

### 5. 证据集膨胀

初次回写把 4 个类别的**全部历史**写入：7,213 条、文件 2.5 MB。而证据规则要求的是「每个证券最新一份定期报告」这个最小集。按证券截断后 **115 条 / 173 KB**，语义反而更正确。

### 6. 研究分级从未写入数据

分级规则只写在页面里（`investment-universe-page.ts` 的 `researchTier`），`researchPriority` 字段是 98 家清一色 `L1`。字段值全相同，等于没有分级。

修复：规则上移到 domain（`researchTierFor()`），写入 `researchPriority` / `watchStatus` / `researchBasis`；自检断言分级**不得塌缩成单一档**，且无证据的公司不得被提拔。

## 仍然存在的缺口

| 缺口 | 性质 | 说明 |
| --- | --- | --- |
| SK 海力士 | **结构性** | 美股 ADR `SKHY` 只提交 6-K/F-1，无 20-F/10-K；韩国线 `000660.KS` 无一手适配器 |
| 保险 P/EV 与 NBV | **数据结构** | 东财 F10 不返回新业务价值字段 |
| 保险股 EBITDA | **披露约束** | 全部报告期无现金流量表补充资料，恒为 `null` 并给显式 gap |
| 前瞻 PE | **数据源空** | 项目内盈利预测为人工整理文档，当前 0 条 |
| 区间倍数校准 | **需要价格源** | 仍是人工默认值，尚未用真实可比公司倍数分布校准 |

## 复算命令

```bash
npm run check:all                                      # 全量自检
node scripts/collect-universe-evidence.mjs --dry-run    # 覆盖率与失败原因
node scripts/collect-universe-evidence.mjs              # 回写（串行，需本地 API）
npm run sync:investment-universe:valuation --write      # 派生字段
npm run audit:valuation-multiples                       # 98 家倍数可算性
```
