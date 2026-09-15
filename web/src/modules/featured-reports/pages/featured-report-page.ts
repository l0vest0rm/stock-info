import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { validateContent, type FeaturedContent } from '../../../../../src/modules/featured-reports/domain/content';
import styles from './featured-report.css?inline';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
const root = document.getElementById('featured-report-root')!;
root.innerHTML = `<section class="fr-search"><span class="fr-eyebrow">精选研究 · 原文对照</span><h1>研报精选</h1><p>输入视频中的 6 位研报码，阅读完整研报与中文解读</p><form id="fr-form"><label class="visually-hidden" for="fr-code">研报码</label><input id="fr-code" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="请输入研报码" required pattern="[1-9][0-9]{5}"><button>查看研报</button></form><p id="fr-error" role="status" aria-live="polite"></p></section><article id="fr-report" hidden></article>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const markdown = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
function renderSummary(text: string): string {
  const template = document.createElement('template');
  template.innerHTML = markdown(text);
  // Drop source-only columns, without altering financial data columns.
  template.content.querySelectorAll('table').forEach(table => {
    const columns = Array.from(table.querySelectorAll('thead th'))
      .map((cell, index) => /^(页码|原文页码|来源位置|原文位置|来源页码)$/.test(cell.textContent?.trim() || '') ? index : -1)
      .filter(index => index >= 0).reverse();
    table.querySelectorAll('tr').forEach(row => columns.forEach(index => row.children[index]?.remove()));
  });
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    node.textContent = (node.textContent || '')
      .replace(/[（(](?:原文)?第?\s*\d+(?:\s*[—–\-、，,至]\s*\d+)*\s*页(?:[；;，,、]\s*(?:原文)?第?\s*\d+(?:\s*[—–\-、，,至]\s*\d+)*\s*页)*[）)]/g, '')
      .replace(/原文第?\s*\d+(?:\s*[—–\-、，,至]\s*\d+)*\s*页/g, '');
  }
  return template.innerHTML;
}
let content: FeaturedContent;
let pdf: pdfjs.PDFDocumentProxy | undefined;
let loadGeneration = 0;
let pageObserver: IntersectionObserver | undefined;
const renderTasks = new Set<pdfjs.RenderTask>();

$('fr-form').addEventListener('submit', event => {
  event.preventDefault(); const code = $<HTMLInputElement>('fr-code').value.trim();
  if (!/^[1-9]\d{5}$/.test(code)) { $('fr-error').textContent = '请输入 6 位数字研报码'; return; }
  history.pushState(null, '', `?code=${code}`); void load(code);
});
window.addEventListener('popstate', () => { const code = new URLSearchParams(location.search).get('code'); if (code) void load(code); else location.reload(); });
const initialCode = new URLSearchParams(location.search).get('code');
if (initialCode) void load(initialCode);

async function load(code: string) {
  const generation = ++loadGeneration;
  $('fr-error').textContent = '正在加载研报…'; $('fr-report').hidden = true;
  pageObserver?.disconnect();
  for (const task of renderTasks) task.cancel();
  renderTasks.clear();
  await pdf?.destroy(); pdf = undefined;
  try {
    if (!/^[1-9]\d{5}$/.test(code)) throw new Error('请输入 6 位数字研报码');
    const response = await fetch(`/api/featured-reports/${code}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.data) throw new Error(result.msg || '暂时无法读取研报');
    const record = result.data;
    const raw = await fetch(record.contentUrl);
    if (!raw.ok) throw new Error('研报内容暂时无法读取，请稍后重试');
    const nextContent = validateContent(await raw.json());
    if (generation !== loadGeneration) return;
    content = nextContent;
    $('fr-error').textContent = ''; $<HTMLInputElement>('fr-code').value = code;
    document.querySelector('.fr-search')?.classList.add('fr-compact');
    renderReport(code, record.pdfUrl);
    const task = pdfjs.getDocument({ url: record.pdfUrl, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' });
    const loadedPdf = await task.promise;
    if (generation !== loadGeneration) { await loadedPdf.destroy(); return; }
    pdf = loadedPdf;
    if (pdf.numPages !== content.pageCount) throw new Error('原文页数与译文映射不一致');
    await setupContinuousPdf(loadedPdf, generation);
  } catch (error) { if (generation === loadGeneration) $('fr-error').textContent = error instanceof Error ? error.message : String(error); }
}

function renderReport(code: string, pdfUrl: string) {
  const container = $('fr-report'); container.hidden = false;
  container.innerHTML = `<header class="fr-heading"><div><span class="fr-eyebrow">研报码 ${escape(code)}</span><h2>${escape(content.title)}</h2><p>${escape([content.institution, content.reportDate, `${content.pageCount} 页`].filter(Boolean).join(' · '))}</p></div><a class="fr-original-link" href="${escape(pdfUrl)}" target="_blank" rel="noopener">打开原文 ↗</a></header>
    <details class="fr-summary" open><summary>研报精华</summary><div class="fr-markdown">${renderSummary(content.summary)}</div></details>
    <div class="fr-reading-nav"><div class="fr-tabs" role="group" aria-label="阅读显示模式"><button id="fr-show-pdf" aria-pressed="false">原文</button><button id="fr-show-translation" aria-pressed="false">译文</button><button id="fr-show-compare" aria-pressed="true">对照</button></div></div>
    <div class="fr-columns" id="fr-columns" data-mode="compare">${Array.from({ length: content.pageCount }, (_, i) => {
      const blocks = content.sections.flatMap(section => section.blocks).filter(block => block.sourceLocations[0].page === i + 1);
      return `<div class="fr-page-pair"><div class="fr-pdf" id="fr-original-${i + 1}"></div><section class="fr-translation"><div class="fr-markdown">${blocks.map(block => `<div class="fr-block">${markdown(block.translation)}</div>`).join('')}</div></section></div>`;
    }).join('')}</div><p id="fr-pdf-status" role="status">正在加载 PDF…</p>`;
  $('fr-show-pdf').onclick = () => setTab('pdf');
  $('fr-show-translation').onclick = () => setTab('translation');
  $('fr-show-compare').onclick = () => setTab('compare');
}
function setTab(tab: 'pdf' | 'translation' | 'compare') {
  $('fr-columns').dataset.mode = tab;
  for (const mode of ['pdf', 'translation', 'compare']) {
    $(`fr-show-${mode}`).setAttribute('aria-pressed', String(mode === tab));
  }
}
async function setupContinuousPdf(documentPdf: pdfjs.PDFDocumentProxy, generation: number) {
  // Reserve every page's space so scrolling and source links never replace a page.
  const pages: { page: pdfjs.PDFPageProxy; sheet: HTMLDivElement }[] = [];
  for (let number = 1; number <= documentPdf.numPages; number++) {
    const page = await documentPdf.getPage(number);
    if (generation !== loadGeneration) return;
    const viewport = page.getViewport({ scale: 1 });
    const sheet = document.createElement('div');
    sheet.id = `fr-pdf-page-${number}`; sheet.className = 'fr-pdf-page';
    sheet.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    sheet.innerHTML = `<canvas aria-label="PDF 原文第 ${number} 页"></canvas>`;
    $(`fr-original-${number}`).append(sheet);
    pages.push({ page, sheet });
  }
  if (generation !== loadGeneration) return;
  const byElement = new Map(pages.map(item => [item.sheet, item]));
  // Render pages near the viewport instead of rasterizing the entire PDF up front.
  pageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const item = byElement.get(entry.target as HTMLDivElement);
      if (!item || generation !== loadGeneration) continue;
      if (entry.isIntersecting) void paint(item);
    }
  }, { rootMargin: '800px 0px' });
  const painted = new Set<HTMLElement>();
  async function paint({ page, sheet }: typeof pages[number]) {
    if (painted.has(sheet) || generation !== loadGeneration) return;
    painted.add(sheet);
    let task: pdfjs.RenderTask | undefined;
    try {
      const width = Math.max(600, sheet.clientWidth);
      const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = sheet.querySelector('canvas')!;
      canvas.width = Math.round(viewport.width * dpr); canvas.height = Math.round(viewport.height * dpr);
      task = page.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
      renderTasks.add(task); await task.promise;
    } catch (error) {
      if (generation === loadGeneration) { painted.delete(sheet); sheet.dataset.error = String(error); $('fr-pdf-status').textContent = `PDF 加载失败：${String(error)}`; }
    } finally { if (task) renderTasks.delete(task); }
  }
  for (const { sheet } of pages) pageObserver.observe(sheet);
  await paint(pages[0]);
  if (generation === loadGeneration && !pages.some(({ sheet }) => sheet.dataset.error)) $('fr-pdf-status').textContent = `共 ${documentPdf.numPages} 页`;
}
