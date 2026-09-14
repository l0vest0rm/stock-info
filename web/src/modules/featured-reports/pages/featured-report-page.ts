import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { validateContent, type FeaturedContent, type SourceLocation } from '../../../../../src/modules/featured-reports/domain/content';
import styles from './featured-report.css?inline';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
const root = document.getElementById('featured-report-root')!;
root.innerHTML = `<section class="fr-search"><span class="fr-eyebrow">精选研究 · 原文对照</span><h1>研报精选</h1><p>输入视频中的 6 位研报码，阅读完整研报与中文解读</p><form id="fr-form"><label class="visually-hidden" for="fr-code">研报码</label><input id="fr-code" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="请输入研报码" required pattern="[1-9][0-9]{5}"><button>查看研报</button></form><p id="fr-error" role="status" aria-live="polite"></p></section><article id="fr-report" hidden></article>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const markdown = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
let content: FeaturedContent;
let pdf: pdfjs.PDFDocumentProxy | undefined;
let page = 1, zoom = 1, renderGeneration = 0, loadGeneration = 0;
let renderTask: pdfjs.RenderTask | undefined;
let review: { token: string; issues: string[] } | undefined;
let contentHash = '';
let currentLocations: SourceLocation[] = [];
let resizeObserver: ResizeObserver | undefined;

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
  renderTask?.cancel(); resizeObserver?.disconnect(); await pdf?.destroy(); pdf = undefined;
  review = undefined; page = 1; zoom = 1; currentLocations = [];
  try {
    if (!/^[1-9]\d{5}$/.test(code) && !(code === 'review' && location.hostname === '127.0.0.1')) throw new Error('请输入 6 位数字研报码');
    const response = await fetch(`/api/featured-reports/${code}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.data) throw new Error(result.msg || '暂时无法读取研报');
    const record = result.data;
    const raw = await fetch(record.contentUrl);
    if (!raw.ok) throw new Error('研报内容暂时无法读取，请稍后重试');
    const nextContent = validateContent(await raw.json());
    if (generation !== loadGeneration) return;
    content = nextContent; contentHash = record.contentHash; review = code === 'review' ? record.review : undefined;
    $('fr-error').textContent = ''; $<HTMLInputElement>('fr-code').value = code === 'review' ? '' : code;
    document.querySelector('.fr-search')?.classList.add('fr-compact');
    renderReport(code, record.pdfUrl);
    const task = pdfjs.getDocument({ url: record.pdfUrl, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' });
    const loadedPdf = await task.promise;
    if (generation !== loadGeneration) { await loadedPdf.destroy(); return; }
    pdf = loadedPdf;
    if (pdf.numPages !== content.pageCount) throw new Error('原文页数与译文映射不一致');
    await renderPdf();
    resizeObserver = new ResizeObserver(() => { void renderPdf(); }); resizeObserver.observe($('fr-pdf-view'));
  } catch (error) { if (generation === loadGeneration) $('fr-error').textContent = error instanceof Error ? error.message : String(error); }
}

function renderReport(code: string, pdfUrl: string) {
  const container = $('fr-report'); container.hidden = false;
  container.innerHTML = `<header class="fr-heading"><div><span class="fr-eyebrow">${review ? '本地审阅' : `研报码 ${escape(code)}`}</span><h2>${escape(content.title)}</h2><p>${escape([content.institution, content.reportDate, `${content.pageCount} 页`].filter(Boolean).join(' · '))}</p></div><a class="fr-original-link" href="${escape(pdfUrl)}" target="_blank" rel="noopener">打开原文 ↗</a></header>
    ${review ? `<aside class="fr-review"><h3>审阅与修改</h3><details><summary>待核对事项（${review.issues.length}）</summary><ul>${review.issues.map(i => `<li>${escape(i)}</li>`).join('')}</ul></details><p>展开下方编辑框可修改标题、总结、章节及译文；修改后保存到本地。</p><button id="fr-edit">编辑内容</button> <button id="fr-save">保存修改</button> <label><input type="checkbox" id="fr-approve">已核对全文及待核对事项，确认可发布</label><span id="fr-save-status" role="status"></span></aside>` : ''}
    <details class="fr-summary" open><summary>研报精华</summary><div class="fr-markdown">${markdown(content.summary)}</div>${review ? `<textarea class="fr-editor" id="fr-summary-edit" aria-label="编辑总结" hidden>${escape(content.summary)}</textarea><label class="fr-editor" hidden>报告标题<input id="fr-title-edit" value="${escape(content.title)}"></label><label class="fr-editor" hidden>机构<input id="fr-institution-edit" value="${escape(content.institution)}"></label><label class="fr-editor" hidden>日期<input id="fr-date-edit" type="date" value="${escape(content.reportDate)}"></label>` : ''}</details>
    <div class="fr-reading-nav"><label>章节 <select id="fr-section"><option value="">选择章节</option>${content.sections.map((s, i) => `<option value="${i}">${escape(s.title)}</option>`).join('')}</select></label><label><input id="fr-link" type="checkbox" checked> 翻页时定位译文</label><div class="fr-tabs"><button id="fr-show-translation" aria-pressed="true">译文</button><button id="fr-show-pdf" aria-pressed="false">原文</button></div></div>
    <div class="fr-columns" id="fr-columns"><section class="fr-pdf"><div class="fr-toolbar"><strong>原文 PDF</strong><button id="fr-prev" aria-label="上一页">‹</button><label><input id="fr-page" aria-label="PDF页码" type="number" min="1" max="${content.pageCount}" value="1"> / ${content.pageCount}</label><button id="fr-next" aria-label="下一页">›</button><button id="fr-minus" aria-label="缩小">−</button><button id="fr-plus" aria-label="放大">＋</button></div><div id="fr-pdf-view"><div id="fr-canvas-wrap"><canvas id="fr-canvas" aria-label="PDF原文页面"></canvas><div id="fr-highlights"></div></div><p id="fr-pdf-status" role="status">正在加载 PDF…</p></div></section>
    <section class="fr-translation"><div class="fr-toolbar"><strong>中文全文翻译</strong><span>点击页码对照原文</span></div><div id="fr-translation-scroll">${content.sections.map((s, i) => `<section id="fr-section-${i}"><h3>${escape(s.title)}</h3>${review ? `<input class="fr-editor" data-section="${i}" aria-label="编辑章节 ${i+1}" value="${escape(s.title)}" hidden>` : ''}${s.blocks.map(b => `<div class="fr-block" id="${escape(b.id)}"><button class="fr-source" data-block="${escape(b.id)}">查看原文第 ${[...new Set(b.sourceLocations.map(l => l.page))].join('、')} 页</button><div class="fr-markdown">${markdown(b.translation)}</div>${review ? `<textarea class="fr-editor" data-edit="${escape(b.id)}" aria-label="编辑段落 ${escape(b.id)}" hidden>${escape(b.translation)}</textarea>` : ''}</div>`).join('')}</section>`).join('')}</div></section></div>`;
  $('fr-section').addEventListener('change', () => {
    const i = Number($<HTMLSelectElement>('fr-section').value);
    if (!content.sections[i]) return;
    focusTranslation(`fr-section-${i}`); void locate(content.sections[i].blocks[0].sourceLocations);
  });
  container.querySelectorAll<HTMLButtonElement>('[data-block]').forEach(button => button.addEventListener('click', () => {
    const block = content.sections.flatMap(s => s.blocks).find(b => b.id === button.dataset.block)!;
    setTab('pdf'); void locate(block.sourceLocations);
  }));
  $('fr-prev').onclick = () => { void changePage(page - 1); };
  $('fr-next').onclick = () => { void changePage(page + 1); };
  $('fr-page').onchange = () => { void changePage(Number($<HTMLInputElement>('fr-page').value)); };
  $('fr-minus').onclick = () => { zoom = Math.max(.6, zoom - .2); void renderPdf(); };
  $('fr-plus').onclick = () => { zoom = Math.min(2.5, zoom + .2); void renderPdf(); };
  $('fr-show-pdf').onclick = () => { setTab('pdf'); void renderPdf(); };
  $('fr-show-translation').onclick = () => setTab('translation');
  if (review) {
    $('fr-edit').onclick = () => container.querySelectorAll<HTMLElement>('.fr-editor').forEach(e => { e.hidden = !e.hidden; });
    $('fr-save').onclick = () => { void saveReview(); };
  }
}
function setTab(tab: string) {
  $('fr-columns').classList.toggle('fr-pdf-active', tab === 'pdf');
  $('fr-show-pdf').setAttribute('aria-pressed', String(tab === 'pdf'));
  $('fr-show-translation').setAttribute('aria-pressed', String(tab !== 'pdf'));
}
function focusTranslation(id: string) {
  const element = document.getElementById(id), scroll = $('fr-translation-scroll');
  if (element) scroll.scrollTo({ top: scroll.scrollTop + element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12, behavior: 'smooth' });
}
async function locate(locations: SourceLocation[]) {
  currentLocations = locations; page = locations[0].page; await renderPdf();
}
async function changePage(next: number) {
  if (!Number.isInteger(next)) return;
  page = Math.max(1, Math.min(content.pageCount, next)); currentLocations = [];
  if ($<HTMLInputElement>('fr-link').checked) {
    const block = content.sections.flatMap(s => s.blocks).find(b => b.sourceLocations.some(l => l.page === page));
    if (block) focusTranslation(block.id);
  }
  await renderPdf();
}
async function renderPdf() {
  if (!pdf || !$('fr-pdf-view')) return;
  const generation = ++renderGeneration;
  renderTask?.cancel();
  try { await renderTask?.promise; } catch { /* A newer page replaces this canvas render. */ }
  if (generation !== renderGeneration) return;
  try {
    const p = await pdf.getPage(page);
    if (generation !== renderGeneration) return;
    const width = Math.max(280, $('fr-pdf-view').clientWidth - 32);
    const viewport = p.getViewport({ scale: width / p.getViewport({ scale: 1 }).width * zoom });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = $<HTMLCanvasElement>('fr-canvas');
    canvas.width = Math.round(viewport.width * dpr); canvas.height = Math.round(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    $('fr-canvas-wrap').style.width = `${viewport.width}px`;
    renderTask = p.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }); await renderTask.promise;
    if (generation !== renderGeneration) return;
    $('fr-highlights').innerHTML = currentLocations.filter(l => l.page === page).map(l => {
      const [x0, y0, x1, y1] = l.bbox;
      return `<span style="left:${x0*100}%;top:${y0*100}%;width:${(x1-x0)*100}%;height:${(y1-y0)*100}%"></span>`;
    }).join('');
    $<HTMLInputElement>('fr-page').value = String(page); $('fr-pdf-status').textContent = `原文第 ${page} 页`;
  } catch (e) { if (generation === renderGeneration) $('fr-pdf-status').textContent = `PDF 加载失败：${String(e)}`; }
}
async function saveReview() {
  if (!review) return;
  const button = $<HTMLButtonElement>('fr-save'); button.disabled = true;
  try {
    content.summary = $<HTMLTextAreaElement>('fr-summary-edit').value;
    content.title = $<HTMLInputElement>('fr-title-edit').value;
    content.institution = $<HTMLInputElement>('fr-institution-edit').value;
    content.reportDate = $<HTMLInputElement>('fr-date-edit').value;
    root.querySelectorAll<HTMLInputElement>('[data-section]').forEach(e => { content.sections[Number(e.dataset.section)].title = e.value; });
    const blocks = new Map(content.sections.flatMap(s => s.blocks).map(b => [b.id, b]));
    root.querySelectorAll<HTMLTextAreaElement>('[data-edit]').forEach(e => { blocks.get(e.dataset.edit!)!.translation = e.value; });
    validateContent(content);
    const response = await fetch('/__review/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': review.token }, body: JSON.stringify({ content, expectedHash: contentHash, approve: $<HTMLInputElement>('fr-approve').checked }) });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json(); contentHash = result.contentHash;
    // Keep the reading preview consistent with the editable source without losing scroll.
    root.querySelectorAll<HTMLElement>('.fr-block').forEach(e => { const block = blocks.get(e.id); if (block) e.querySelector('.fr-markdown')!.innerHTML = markdown(block.translation); });
    root.querySelector('.fr-summary .fr-markdown')!.innerHTML = markdown(content.summary);
    root.querySelector('.fr-heading h2')!.textContent = content.title;
    root.querySelector('.fr-heading p')!.textContent = [content.institution, content.reportDate, `${content.pageCount} 页`].filter(Boolean).join(' · ');
    content.sections.forEach((section, index) => {
      $(`fr-section-${index}`).querySelector('h3')!.textContent = section.title;
      $<HTMLSelectElement>('fr-section').options[index + 1].textContent = section.title;
    });
    $('fr-save-status').textContent = result.approved ? '已保存并确认，可运行发布脚本' : '修改已保存，尚未确认发布';
  } catch (e) { $('fr-save-status').textContent = String(e); }
  finally { button.disabled = false; }
}
