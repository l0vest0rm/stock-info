import { h, type VNodeChild } from "vue";

import type { WebResearchTask } from '../../../../shared/web-research';
export type WebResearchReportTask = WebResearchTask;
export type WebResearchReportRecovery = { phase?: "none" | "recovering" | "manual_required"; reason?: string | null };
export type WebResearchReportState = { canManageLocally?: boolean; task?: WebResearchReportTask | null; recovery?: WebResearchReportRecovery | null; report?: { markdown?: string } | null; resume?: { available?: boolean } | null };

export function webResearchReportPending(state: WebResearchReportState | null | undefined): boolean {
  const status = state?.task?.status;
  return status === "queued" || status === "leased" || status === "running" || status === "interrupt_requested" || state?.recovery?.phase === "recovering";
}

export function webResearchReportStatus(state: WebResearchReportState | null | undefined): string {
  if (state?.recovery?.phase === "recovering") return "正在找回";
  if (state?.recovery?.phase === "manual_required") return "需人工处理";
  return ({ queued: "已排队", leased: "本机已领取", running: "正在生成", interrupt_requested: "正在中断", succeeded: "已完成", failed: "失败", interrupted: "已中断", superseded: "已替代" } as Record<string, string>)[state?.task?.status || ""] || (state?.report?.markdown ? "已完成" : "尚未提交");
}

export function webResearchReportFailed(state: WebResearchReportState | null | undefined): boolean {
  return state?.recovery?.phase === "manual_required" || state?.task?.status === "failed" || state?.task?.status === "interrupted" || state?.task?.status === "superseded";
}

/** Development-only content uses the capability supplied by the runtime API. */
export function renderWebResearchReportDiagnostics(state: WebResearchReportState | null | undefined, content: VNodeChild): VNodeChild | null {
  return state?.canManageLocally === true ? content : null;
}

/** Report timestamps are public; execution identifiers are local diagnostics. */
export function renderWebResearchReportIdentity(state: WebResearchReportState | null | undefined, className = "webResearch-report-meta"): VNodeChild | null {
  const task = state?.task;
  if (!task) return null;
  const fields: Array<{ label: string; value: string; code?: boolean }> = [];
  const taskId = String(task.runId || task.taskId || "").trim();
  const name = String(task.name || "").trim();
  if (state?.canManageLocally === true && taskId) fields.push({ label: task.runId ? "本地执行 ID" : "旧执行 ID", value: taskId, code: true });
  if (state?.canManageLocally === true && name) fields.push({ label: "研究业务名", value: name, code: true });
  const createdAt = formatWebResearchReportTimestamp(task.createdAt);
  const updatedAt = formatWebResearchReportTimestamp(task.updatedAt);
  const completedAt = formatWebResearchReportTimestamp(task.completedAt);
  if (createdAt) fields.push({ label: "创建", value: createdAt });
  if (updatedAt) fields.push({ label: "更新", value: updatedAt });
  if (completedAt) fields.push({ label: "完成", value: completedAt });
  if (!fields.length) return null;
  return h("div", { class: className }, fields.map((field) => h("span", { key: field.label }, ["", `${field.label}：`, field.code ? h("code", { class: "font-monospace text-break" }, field.value) : field.value])));
}

export function renderWebResearchReportActions(options: {
  state: WebResearchReportState | null | undefined;
  enabled?: boolean;
  busy?: boolean;
  className?: string;
  buttonClass?: string;
  submitLabel: string;
  resubmitLabel?: string;
  onSubmit(): void;
  onSync?(): void;
  onResume?(): void;
}): VNodeChild | null {
  if (options.enabled === false) return null;
  const disabled = Boolean(options.busy) || webResearchReportPending(options.state);
  const runId = options.state?.task?.runId;
  const localAction = (action: 'resume' | 'cancel') => async (event: MouseEvent) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const path = action === 'resume'
        ? `/api/research/web-workflows/${encodeURIComponent(runId || '')}/resume`
        : `/api/research/web-workflows/${encodeURIComponent(runId || '')}/cancel`;
      const response = await fetch(path, { method: 'POST' });
      const body = await response.json();
      if (!response.ok || body.code !== 200) throw new Error(body.msg || '本地操作失败');
      if (action === 'resume' && body.data?.recovering !== true) throw new Error('无法安全恢复，请同步查看原执行状态');
      options.onSync?.();
    } catch (error) {
      button.textContent = '操作未完成，请同步查看';
      button.title = error instanceof Error ? error.message : '本地操作失败';
    } finally { button.disabled = false; }
  };
  return h("div", { class: options.className || "webResearch-report-actions" }, [
    options.state?.task && options.onSync ? h("button", { type: "button", class: options.buttonClass, disabled: options.busy, onClick: options.onSync }, options.busy ? "正在同步" : "同步本地状态") : null,
    options.state?.resume?.available && options.onResume ? h("button", { type: "button", class: options.buttonClass, disabled, onClick: options.onResume }, "找回已提交结果") : null,
    runId && ['failed', 'interrupted'].includes(options.state?.task?.status || '') && !(options.state?.resume?.available && options.onResume) ? h("button", { type: "button", class: options.buttonClass, disabled, onClick: localAction('resume') }, '恢复原执行') : null,
    runId && webResearchReportPending(options.state) ? h("button", { type: "button", class: options.buttonClass, disabled: options.busy, onClick: localAction('cancel') }, '停止本地执行') : null,
    h("button", { type: "button", class: options.buttonClass, disabled, onClick: options.onSubmit }, webResearchReportPending(options.state) ? webResearchReportStatus(options.state) : options.state?.report?.markdown ? (options.resubmitLabel || `重新${options.submitLabel}`) : options.submitLabel),
  ]);
}

export function renderWebResearchReportMessage(state: WebResearchReportState | null | undefined, error: string | null | undefined, pendingMessage: string, className = "webResearch-report-message"): VNodeChild[] {
  if (state?.canManageLocally !== true) {
    return error ? [h("div", { class: `${className} error`, role: "alert" }, "报告暂时无法加载，请稍后重试。")] : [];
  }
  const recovery = state?.recovery;
  const task = state?.task;
  return [
    error ? h("div", { class: `${className} error`, role: "alert" }, error) : null,
    recovery?.phase === "manual_required" ? h("div", { class: `${className} error`, role: "status" }, recovery.reason || "无法确认原会话，需人工处理。") : null,
    recovery?.phase === "recovering" ? h("div", { class: className, role: "status" }, recovery.reason || "正在从原检查点恢复；已派发动作不会自动重放。") : null,
    task?.status === "failed" && recovery?.phase !== "manual_required" ? h("div", { class: `${className} error`, role: "status" }, state?.resume?.available ? "可从原检查点恢复执行；已派发动作不会自动重放。" : task.errorMessage || "本机 CEA 执行未完成。") : null,
    webResearchReportPending(state) && recovery?.phase !== "recovering" ? h("div", { class: className, role: "status" }, pendingMessage) : null,
  ].filter(Boolean) as VNodeChild[];
}

/** Minimal safe Markdown renderer shared by webResearch report pages; never inject model HTML. */
export function renderWebResearchMarkdown(markdown: string): VNodeChild[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: VNodeChild[] = [];
  for (let index = 0; index < lines.length;) {
    const line = unescapeMarkdown(lines[index].trim());
    if (!line) { index += 1; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push(h(`h${Math.min(heading[1].length, 4)}`, { key: `heading-${index}` }, inlineMarkdown(heading[2]))); index += 1; continue; }
    if (/^```/.test(line)) { const code: string[] = []; index += 1; while (index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index++]); if (index < lines.length) index += 1; blocks.push(h("pre", { key: `code-${index}` }, [h("code", code.join("\n"))])); continue; }
    // A thematic break such as `* * *` must win over unordered-list parsing.
    if (isThematicBreak(line)) { blocks.push(h("hr", { key: `break-${index}` })); index += 1; continue; }
    if (line.startsWith("|") && /^[\s|:-]+$/.test(lines[index + 1]?.trim() || "")) {
      const header = tableCells(line); index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) rows.push(tableCells(unescapeMarkdown(lines[index++].trim())));
      blocks.push(h("table", { key: `table-${index}` }, [h("thead", [h("tr", header.map((cell, cellIndex) => h("th", { key: cellIndex }, inlineMarkdown(cell))))]), h("tbody", rows.map((row, rowIndex) => h("tr", { key: rowIndex }, row.map((cell, cellIndex) => h("td", { key: cellIndex }, inlineMarkdown(cell))))))]));
      continue;
    }
    const list = /^([-*+] |\d+\. )(.+)$/.exec(line);
    if (list) { const ordered = /^\d+\. /.test(line); const matcher = ordered ? /^\d+\.\s+(.+)$/ : /^[-*+]\s+(.+)$/; const items: string[] = []; while (index < lines.length) { const item = matcher.exec(lines[index].trim()); if (!item) break; items.push(item[1]); index += 1; } blocks.push(h(ordered ? "ol" : "ul", { key: `list-${index}` }, items.map((item, itemIndex) => h("li", { key: itemIndex }, inlineMarkdown(item))))); continue; }
    if (line.startsWith(">")) { blocks.push(h("blockquote", { key: `quote-${index}` }, inlineMarkdown(line.replace(/^>\s?/, "")))); index += 1; continue; }
    const paragraph = [line]; index += 1; while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|```|>)/.test(lines[index].trim())) paragraph.push(lines[index++].trim()); blocks.push(h("p", { key: `paragraph-${index}` }, inlineMarkdown(paragraph.join(" "))));
  }
  return blocks;
}

function inlineMarkdown(source: string): Array<string | VNodeChild> {
  source = unescapeMarkdown(source);
  const nodes: Array<string | VNodeChild> = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > offset) nodes.push(source.slice(offset, start));
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) nodes.push(h("strong", token.slice(2, -2)));
    else if (token.startsWith("`")) nodes.push(h("code", token.slice(1, -1)));
    else { const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token); nodes.push(link ? h("a", { href: link[2], target: "_blank", rel: "noreferrer" }, link[1]) : token); }
    offset = start + token.length;
  }
  if (offset < source.length) nodes.push(source.slice(offset));
  return nodes;
}

function tableCells(line: string): string[] { return line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()); }
function isThematicBreak(line: string): boolean { return /^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(line); }
function unescapeMarkdown(value: string): string { return value.replace(/\\([\\`*_{}\[\]<>()#+.!-])/g, "$1"); }
function formatWebResearchReportTimestamp(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(Number(value)));
}
