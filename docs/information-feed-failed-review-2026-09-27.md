# 资讯提取失败全量复核（2026-09-27）

## 范围与状态

本地持久化状态共 17 条失败：12 条符合现行白名单，5 条已被现行白名单排除。页面当时显示 11 条，俄罗斯天然气产量一条已超过自动提取的 48 小时窗口。没有删除失败记录或手工写成功状态。

## v10 修复

- 合同冲突：系统将明确计划定义为 guidance，而收购、持股变动、诉讼仅允许 fact/event。按实际语义增加 guidance；监管许可支持明确的计划及预测，仍须保留未获批状态。不是将所有类型放开。
- 期间语法：支持原文中的省略重复月/年的日期区间、月度区间、单独年份、近似年份、半年及中文数字时长；来源逐字约束、日历合法性与先后顺序仍生效，不补造年份。
- 主体与陈述：明确主体不拼接产量、资本开支等指标；将上次校验错误作为有边界的 JSON 数据反馈给下一次正常提取，仍须完整通过原验证，未增加绕过校验的修复写入。
- 消耗根因：过去每次提示词升级都会对所有旧合同成功结果重新提取，耗尽每日额度。自动处理现在保留已冻结合同且输入未变的成功结果；实际检查 309 条旧成功结果可保留。显式 doc-id 操作仍可更新。
- 历史失败可用 `./process-information-feed-local.sh --mode tag --doc-id <id> --retry-failed --max-tags 1` 单条修复。必须指定 doc-id，仅选择 failed 状态；只放宽该条的年龄限制，不绕过白名单、每日额度、租约、退避或次数上限。自动处理仍限 48 小时。
- v9 合同已冻结，v10 用于新提取。未部署生产。

## 逐条证据

| 资讯 | 原始错误 | 处理 |
| --- | --- | --- |
| 中信证券：建议港股投资者优先关注电力等防御属性较强且分红稳定的优质行业 | invalid feed record fields: statement must include entity "港股防御型行业" | 修复规则后待额度允许，走正常重提取 |
| 海思科：创新药HSK42360-Na片纳入突破性治疗药物程序 | invalid feed record fields: unsupported category/informationType: regulatory_approval/forecast | 修复规则后待额度允许，走正常重提取 |
| 通鼎互联：拟1亿元收购南京和本机电14.2984%股权 | invalid feed record fields: unsupported category/informationType: acquisition/guidance | 修复规则后待额度允许，走正常重提取 |
| 中科飞测：实控人的一致行动人拟减持不超0.28%股份 | invalid feed record fields: unsupported category/informationType: shareholding_change/guidance; invalid period: "三个月" | 修复规则后待额度允许，走正常重提取 |
| 巴基斯坦西北部德拉伊斯梅尔汗发生爆炸，造成11人遇难，30人受伤。 | invalid feed category candidate fields | 白名单已排除：whitelist_miss |
| 挪威天然气运输系统运营商Gassco将其对9月25日至28日计划天然气停运规模的预估从此前的470万立方米上调至550万立方米。 | invalid feed record fields: invalid period: "2026-09-25至2026-09-28" | 修复规则后待额度允许，走正常重提取 |
| 苹果因涉触觉反馈专利侵权被判赔偿57亿美元 公司称将提起上诉 | invalid feed record fields: unsupported category/informationType: litigation/guidance | 修复规则后待额度允许，走正常重提取 |
| SK海力士旗下Solidigm据称最早拟于2027年赴美IPO | invalid feed record fields: invalid period: "2027年" | 修复规则后待额度允许，走正常重提取 |
| 2028年前后 FAST有望实现全链条国产化 | invalid feed record fields: invalid period: "2028年前后" | 修复规则后待额度允许，走正常重提取 |
| 周六你需要知道的隔夜全球要闻：美伊谈判再传重大进展，美联储官员密集释放鹰派信号，苹果再创历史收盘新高，美债收益率继续飙升 | invalid feed record fields: statement must include entity "美国超大规模云计算企业资本开支" | 修复规则后待额度允许，走正常重提取 |
| 国际原油期货结算价收跌超2% | LLM stream did not start within 120000ms (client_request_id=none, http_status=none, response_bytes=0) | 白名单已排除：price_only |
| 秘鲁矿业部长预计今年秘鲁铜产量为250万-270万吨 | invalid feed record fields: statement must include entity "秘鲁铜产量" | 修复规则后待额度允许，走正常重提取 |
| 加拿大7月预算赤字为47.7亿加元 | invalid feed record fields: invalid period: "2026年4月至7月" | 修复规则后待额度允许，走正常重提取 |
| 俄罗斯天然气工业股份公司上半年天然气产量增加3.4%，达到2165.5亿立方米。 | invalid feed record fields: invalid period: "上半年" | 修复规则后待额度允许，走正常重提取 |
| 欧元区8月份居民贷款同比增长3.1%。 | invalid feed record fields | 白名单已排除：whitelist_miss |
| 欧洲央行称，8月对企业的贷款增长4.2%，7月增长4.4% 。 | invalid feed record fields | 白名单已排除：whitelist_miss |
| 日均240万人次 中秋、国庆假期民航旅客量将再创同期新高 | invalid feed category candidate fields | 白名单已排除：whitelist_miss |

## 验证与剩余边界

38 项针对性断言通过（来源约束、日期合法性、倒序、中文时长、四类计划与监管预测）；非法批量历史重试参数被拒绝。标准 `./start-local.sh` 的类型检查、构建与迁移通过，`npm run test:basic` 通过。

当前每日计数已达 500/500，重提取尚未执行；已询问用户是否允许提高到 600。未重置计数、替换额度文件或自动提高上限。剩余 12 条不能宣称已成功，5 条过滤记录保留原始审计状态。修复前快照位于忽略的 `data/local/feed-failed-review-before.json`。
