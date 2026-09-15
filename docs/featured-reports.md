# 研报精选

人工精选 PDF → 本地提取、gpt-5.6-luna 翻译和总结 → 本地审阅 → 发布两个 R2 对象 → 六位研报码阅读。

## 准备环境

使用仓库标准 `./start-local.sh` 构建页面并启动 Node 本地服务。运行脚本需要 Node 22.5+、Python 3 和 PyMuPDF（`python3 -m pip install pymupdf`）。扫描 PDF 还需要 Tesseract 及 eng/chi_sim 语言包，macOS 可安装 `brew install tesseract tesseract-lang`。可以用 `PYTHON_BIN` 指定 Python。

模型使用现有本地 `OPENAI_API_KEY`/`OPENAI_BASE_URL`，也兼容 `LLM_API_KEY`/`LLM_BASE_URL`。凭据从环境或忽略的 `.dev.vars` 读取。支持的准备脚本显式设置 `LLM_RUNTIME=local`；Worker 保持 `LLM_RUNTIME=production`，不执行模型任务。

## 翻译批次

全文按容量合并，允许跨章节；能放入一批的整篇只调用一次翻译。每段携带章节 ID，返回后还原章节、段落顺序与原文定位。整篇一批时一次调用同时完成全文翻译、术语统一及整体总结，不单独生成术语表。只有多批时，总调用次数才是翻译批次数 + 2（共享术语表、整体总结各一次）。启动时打印批次数及计划调用次数。

当前应用预算保留每次 16,000 输出 token，其中预计译文使用至多 12,000，余量用于 JSON、章节标题、整体总结及长度波动；输入文本块序列化后至多 24,000 UTF-8 字节。译文估算区分 ASCII 和非 ASCII 字符，并计入每段结构开销。这是保守应用预算，不是已确认的 Luna 模型上下文上限或无幻觉保证。超预算才分批，单段超预算在调用前提示拆分。

翻译前按明确标题和固定法律措辞排除免责声明、法律声明、分析师认证、利益冲突披露、分发限制和版权声明；明确的声明章节整体跳过，正文中的独立固定声明按整段跳过，不进入翻译、术语表或总结输入。通用的风险、法律行业和估值章节仍保留。识别规则采用保守匹配，未识别的声明仍会翻译；原 PDF 和 source.json 完整保留。checks.json 的 skippedBlocks 记录跳过原因及原文位置，审阅事项同时提示逐项核对。审阅与发布仍要求所有研究正文有译文且来源位置不变，仅允许这些可识别的固定段落缺省；旧的完整译文仍兼容。已有 content.json 不会自动重写，重新生成请指定新的 --out 目录。

所有待翻译段落 ID、章节 ID、顺序及非空译文都会校验，数字差异继续进入人工核对清单。模型、提示词和输入共同决定缓存键，旧批次结果不会误用于新批次；已有完整产物及人工修改仍保留。

## 两个脚本

```sh
./prepare-featured-report.sh 'https://example.com/report.pdf' --title '报告标题' --institution '发布机构' --date 2026-09-14
./prepare-featured-report.sh '/absolute/path/report.pdf'
```

输出默认在忽略目录 `data/featured-reports/<PDF的SHA256>/`；可用 `--out DIR` 指定。URL 下载、提取、模型结果都有本地缓存，失败重跑会继续。已存在 `content.json` 时保留人工修改；要重新生成，指定新的输出目录。`--extract-only` 只提取，不调用模型。

```sh
./prepare-featured-report.sh --review 'data/featured-reports/<报告ID>'
```

正常准备完成后会自动登记六位本地研报码，并输出 `http://127.0.0.1:8000/featured-report.html?code=<本地研报码>`。运行 `./start-local.sh` 后即可直接打开链接，也可以在本地研报精选页输入该码；不需要先上传 Cloudflare，也不需要额外启动审阅服务。登记保存在忽略的 `data/local/featured-reports/`，服务重启后仍有效，同一输出目录重跑复用编号，`--out` 自定义目录同样支持。`--extract-only` 不登记。已有产物重新执行原准备命令即可登记，不会重新翻译。本地码和正式发布码独立，发布后的正式编号以发布脚本输出为准。

上面的 `--review` 命令仍支持独立审阅服务，地址为 `http://127.0.0.1:8791/featured-report.html?code=100000`。本地与 Cloudflare 共用同一套只读阅读页面，只有 PDF、JSON 的数据来源不同。页面不提供编辑、保存或确认发布功能；需要修改内容时告诉开发助手，修改后重新查看。确认内容后运行发布命令即可，发布仍校验结构、段落覆盖和 PDF 身份，不要求页面勾选或 review.json。Ctrl-C 关闭独立查看服务。

```sh
./publish-featured-report.sh 'data/featured-reports/<报告ID>'
```

需要现有 Cloudflare R2 写权限的 `CLOUDFLARE_API_TOKEN`，以及本地与 Worker 一致的 `REPORT_SYNC_TOKEN`。后者复用现有完成报告同步凭据，不进入页面。脚本返回编号及正式阅读地址。发布脚本不会生成或修改译文。生产部署由 `./deploy-cloudflare.sh` 单独执行，包含远程 D1 迁移。

## 内容契约与存储

首次发布两个对象：

```text
featured-reports/<reportId>/original.pdf
featured-reports/<reportId>/<contentHash>/content.json
```

JSON 为 schemaVersion=1，包含 reportId、标题、机构、日期、PDF页数、Markdown总结、章节及译文段落。每段有稳定 ID 和 sourceLocations（PDF实际页码及归一化矩形）。所有图表仍在原 PDF，不上传独立图片；提取出的表格文字保留在译文。扫描页可 OCR，普通图片/图表的未提取文字和数字差异列为人工核对事项，可在相应译文段落中补译。

D1 的 `featured_reports` 仅保存唯一六位 code、唯一 report_id、展示元信息、PDF/JSON路径、JSON哈希、状态与更新时间。此表按用户确认的实施方案添加，已加入 schema guard 及测试。它与资讯知识库的导入和保留期无关。普通知识正文清理只允许 `knowledge-content/` 前缀，不能清理精选目录。

先上传资源，再由带凭据的 `/api/internal/featured-reports` 验证资源及 JSON 哈希、结构后提交索引。数据库唯一约束分配 100000—999999 的随机码；重复发布同一 PDF 复用编号。修订采用 expectedHash 乐观锁，旧任务不覆盖新版本；D1 提交后先保存本地 `published.json`，再验证公共读取。重试不换码。历史 JSON 保留供回退，因此修订后物理对象数量会超过两个；当前发布版本仍只引用两个对象。

公共 `/api/featured-reports/:code` 无需登录，只返回 published 报告；响应不缓存。浏览器直接读取内容域名的 JSON 和 PDF。R2 内容域名需要允许网站 Origin 的 GET/HEAD、Range 请求及必要的响应头。不可变对象长期缓存。编号仅用于导航，不是密码。下架应更新 status='withdrawn' 并永久保留编号；公开的旧 R2 链接不因此撤销。

## 阅读与质量边界

顶部总结，桌面左原文右译文；原文/译文/对照切换（默认对照），不显示目录、段落索引、来源页码按钮或总结中的来源位置；原文与译文按物理页组成共享行，逐页顶部对齐，连续滚动阅读；PDF 保留所有页面位置并在接近视口时渲染，无需翻页按钮。手机同样支持三种显示模式。使用同版本本地 PDF.js worker、字体、CMap、WASM，中文 PDF 不依赖第三方字体地址。Markdown 经过 DOMPurify 清理。

页码采用 PDF 的物理页码，不采用印刷页码。跨页文字目前保留为各页文本块，翻译时附相邻上下文；跨页段落按首个来源页放置且不重复；译文较长时共享行随内容增高，下一页两侧仍从同一高度开始。自动提取不保证复杂多栏/图表100%准确，checks.json 保留 OCR、空页、图片文字、数字差异等待核对项供开发排查，发布前通过普通阅读页面核对内容。

验收重点：文本/多栏表格/扫描样本提取，真实模型分段翻译与续跑，只读查看与内容更新，R2资源完整性，编号碰撞和并发幂等，版本更新冲突，生产 API 与手机/桌面页面。

## 精简模型输出与中文排版

模型只返回按 ID 对应的译文，以及整篇总结（多批时另有内部简短提要）。不再生成独立章节标题列表、引用 ID 列表、目录、索引或来源页码；页码和坐标不发送给模型，仍由程序从提取结果绑定回译文用于对齐和覆盖校验。正文原有标题、数字、条件、风险和表格仍须完整翻译，中文表达要求自然简练，不能为缩短篇幅删减信息。总结约400至600汉字，按内容组织，避免固定栏目导致重复。

中文栏使用14px正文、1.65行距及较小段间距和表格留白，保持可读性；不强制裁切或缩小长页内容。提示词改变会更新模型缓存键，但已有 content.json 按原流程保留；新提示词用于新生成的报告，重新翻译已有报告需新的 --out 目录。

已有译文应用最新声明过滤：

```sh
./prepare-featured-report.sh <原 PDF 路径> --out <已有报告目录> --refilter
```

此操作保留研究正文译文和人工修改，移除识别出的披露附录及固定声明，并仅用过滤后的原文重新生成摘要。原 content/checks 自动备份到报告目录下的 `before-refilter-*`；默认重复运行仍保留已有产物。原 PDF 和来源坐标不变，修改后的内容需重新审阅后发布。

跳过翻译的内容仍在阅读产物中保留中文占位，标注披露类型和未翻译原因。占位按原文段落顺序插入，并保留原段落 ID、页码及坐标，因此对照页不会整页空白；占位由本地生成，声明原文不送入翻译或摘要模型。
