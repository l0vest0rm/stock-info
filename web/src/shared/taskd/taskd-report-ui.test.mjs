import assert from "node:assert/strict";
import test from "node:test";
import { renderTaskdMarkdown } from "./taskd-report-ui.ts";

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
