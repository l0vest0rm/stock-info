# 研报精选

人工精选 PDF → 本地提取、gpt-5.6-luna 翻译和总结 → 本地审阅 → 发布两个 R2 对象 → 六位研报码阅读。

## 准备环境

使用仓库标准 `./start-local.sh` 构建页面并启动 Node 本地服务。运行脚本需要 Node 22.5+、Python 3 和 PyMuPDF（`python3 -m pip install pymupdf`）。扫描 PDF 还需要 Tesseract 及 eng/chi_sim 语言包，macOS 可安装 `brew install tesseract tesseract-lang`。可以用 `PYTHON_BIN` 指定 Python。

模型使用现有本地 `OPENAI_API_KEY`/`OPENAI_BASE_URL`，也兼容 `LLM_API_KEY`/`LLM_BASE_URL`。凭据从环境或忽略的 `.dev.vars` 读取。支持的准备脚本显式设置 `LLM_RUNTIME=local`；Worker 保持 `LLM_RUNTIME=production`，不执行模型任务。

## 两个脚本

```sh
./prepare-featured-report.sh 'https://example.com/report.pdf' --title '报告标题' --institution '发布机构' --date 2026-09-14
./prepare-featured-report.sh '/absolute/path/report.pdf'
```

输出默认在忽略目录 `data/featured-reports/<PDF的SHA256>/`；可用 `--out DIR` 指定。URL 下载、提取、模型结果都有本地缓存，失败重跑会继续。已存在 `content.json` 时保留人工修改；要重新生成，指定新的输出目录。`--extract-only` 只提取，不调用模型。

```sh
./prepare-featured-report.sh --review 'data/featured-reports/<报告ID>'
```

打开脚本返回的 `http://127.0.0.1:8791/featured-report.html?code=review`。本地审阅服务仅绑定回环地址，文件写入有 Origin、随机令牌、原内容哈希检查。点击“编辑内容”修改标题、日期、机构、总结、章节名和译文；可先保存草稿。核对待核对事项后勾选“确认可发布”，再保存。确认绑定文件哈希，之后手动修改 JSON 会自动使确认失效。Ctrl-C 关闭审阅服务。

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

顶部总结，桌面左原文右译文；章节选择、逐段“查看原文”、原文翻页定位译文；PDF 一次只渲染当前页。手机原文/译文切换。使用同版本本地 PDF.js worker、字体、CMap、WASM，中文 PDF 不依赖第三方字体地址。Markdown 经过 DOMPurify 清理。

页码采用 PDF 的物理页码，不采用印刷页码。跨页文字目前保留为各页文本块，翻译时附相邻上下文；不强行按滚动比例同步。自动提取不保证复杂多栏/图表100%准确，审阅页展示 OCR、空页、图片文字、数字差异等待核对项，发布必须经过审阅确认。

验收重点：文本/多栏表格/扫描样本提取，真实模型分段翻译与续跑，审阅修改及失效，R2资源完整性，编号碰撞和并发幂等，版本更新冲突，生产 API 与手机/桌面页面。
