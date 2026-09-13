import assert from "node:assert/strict";
import test from "node:test";
import { renderTaskdMarkdown, renderTaskdReportIdentity, renderTaskdReportDiagnostics, renderTaskdReportMessage } from "./taskd-report-ui.ts";

test("renders spaced asterisk thematic breaks as rules instead of list items", () => {
  const blocks = renderTaskdMarkdown("- 美债官方收盘：2Y **4.39%**\n\n* * *\n\n## 下一章节");

  assert.deepEqual(blocks.map((block) => block.type), ["ul", "hr", "h2"]);
  assert.equal(blocks[0].children[0].type, "li");
  assert.equal(blocks[1].children, null);
});

test("keeps all CommonMark thematic-break marker styles out of lists", () => {
  const blocks = renderTaskdMarkdown("***\n\n- - -\n\n___");

  assert.deepEqual(blocks.map((block) => block.type), ["hr", "hr", "hr"]);
});

const task = { taskId: 110, name: "macro:analysis:global", createdAt: 1788964676000, updatedAt: 1788965363000, completedAt: 1788965363000 };
const labels = (node) => node.children.map((child) => child.key);

test("public reports preserve timestamps without execution diagnostics", () => {
  for (const canManageLocally of [false, undefined]) {
    const state = { task, canManageLocally, recovery: { phase: "manual_required", reason: "internal checkpoint" } };
    assert.deepEqual(labels(renderTaskdReportIdentity(state)), ["创建", "更新", "完成"]);
    assert.equal(renderTaskdReportDiagnostics(state, "local execution instructions"), null);
    assert.deepEqual(renderTaskdReportMessage(state, null, "taskd pending"), []);
    assert.equal(renderTaskdReportMessage(state, "internal error", "taskd pending")[0].children, "报告暂时无法加载，请稍后重试。");
  }
});

test("local reports retain execution identifiers and diagnostic messages", () => {
  const state = { task, canManageLocally: true };
  assert.deepEqual(labels(renderTaskdReportIdentity(state)), ["taskd ID", "taskd 业务名", "创建", "更新", "完成"]);
  assert.equal(renderTaskdReportDiagnostics(state, "local execution instructions"), "local execution instructions");
  assert.equal(renderTaskdReportMessage(state, "diagnostic error", "pending")[0].children, "diagnostic error");
});
