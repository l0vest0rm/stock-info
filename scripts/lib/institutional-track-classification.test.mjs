import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildInstitutionalTrackTaxonomyIndex,
  classifyInstitutionalTrackRow,
  classifyInstitutionalTrackSnapshot,
} from "./institutional-track-classification.mjs";

const taxonomyPath = new URL("../../web/src/config/institutional-track-taxonomy.json", import.meta.url);
const snapshotPath = new URL("../../web/src/config/institutional-track-snapshot.json", import.meta.url);
const overridesPath = new URL("../../web/src/config/institutional-track-overrides.json", import.meta.url);
const taxonomy = JSON.parse(await readFile(taxonomyPath, "utf8"));
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const overrides = JSON.parse(await readFile(overridesPath, "utf8"));

test("taxonomy has unique exact industries and valid primary-secondary pairs", () => {
  const index = buildInstitutionalTrackTaxonomyIndex(taxonomy);
  assert.equal(index.version, 2);
  assert.ok(index.allowedPairs.size > 50);
  assert.ok(index.industryAssignments.size > 70);
  assert.ok(index.companyAssignments.size > 100);
});

test("current Top300 snapshot is fully and reproducibly classified", () => {
  const classified = classifyInstitutionalTrackSnapshot(snapshot, taxonomy);
  assert.equal(classified.rows.length, 300);
  assert.equal(new Set(classified.rows.map((row) => row.code)).size, 300);
  assert.equal(classified.rows.filter((row) => !row.primaryTrack || !row.secondaryTrack).length, 0);
  assert.equal(classified.rows.filter((row) => row.primaryTrack === "其他").length, 0);
  for (const row of classified.rows) {
    const stored = snapshot.rows.find((item) => item.code === row.code);
    assert.equal(stored.primaryTrack, row.primaryTrack, `${row.code} primary track drifted`);
    assert.equal(stored.secondaryTrack, row.secondaryTrack, `${row.code} secondary track drifted`);
  }
});

test("bundled manual overrides stay inside the taxonomy", () => {
  const index = buildInstitutionalTrackTaxonomyIndex(taxonomy);
  const snapshotCodes = new Set(snapshot.rows.map((row) => row.code));
  for (const [code, override] of Object.entries(overrides)) {
    assert.ok(snapshotCodes.has(code), `${code} override is not in the current snapshot`);
    assert.ok(index.allowedPairs.has(`${override.primaryTrack}\u0000${override.secondaryTrack}`), `${code} override uses an invalid track pair`);
  }
});

test("representative companies use principal business instead of incidental concepts", () => {
  const expected = {
    "002371.SZ": ["信息技术", "半导体设备"],
    "688012.SH": ["信息技术", "半导体设备"],
    "688981.SH": ["信息技术", "晶圆制造"],
    "000333.SZ": ["可选消费", "家电"],
    "000651.SZ": ["可选消费", "家电"],
    "600900.SH": ["公用事业与环保", "水电运营"],
    "601601.SH": ["金融", "保险"],
    "601336.SH": ["金融", "保险"],
    "601628.SH": ["金融", "保险"],
    "601377.SH": ["金融", "证券"],
    "300014.SZ": ["电力设备与新能源", "锂电池"],
    "002353.SZ": ["能源", "油服设备"],
    "600150.SH": ["工业与高端制造", "船舶与海工"],
    "600660.SH": ["汽车与出行", "汽车零部件"],
    "001979.SZ": ["地产与基建", "房地产"],
    "601021.SH": ["交通运输与物流", "航空运输"],
    "600089.SH": ["电力设备与新能源", "电网设备"],
    "000933.SZ": ["原材料", "稀有与有色金属"],
    "300316.SZ": ["电力设备与新能源", "光伏设备"],
    "601012.SH": ["电力设备与新能源", "光伏产品"],
    "688813.SH": ["工业与高端制造", "其他工业设备"],
  };
  const byCode = new Map(snapshot.rows.map((row) => [row.code, row]));
  for (const [code, pair] of Object.entries(expected)) {
    const row = byCode.get(code);
    assert.ok(row, `${code} missing from current snapshot`);
    assert.deepEqual([row.primaryTrack, row.secondaryTrack], pair, `${code} classification mismatch`);
  }
});

test("theme concepts cannot override an exact industry assignment", () => {
  const row = classifyInstitutionalTrackRow({
    code: "TEST.SZ",
    name: "测试家电",
    industry: "白色家电",
    concepts: ["液冷概念", "CPO概念", "存储芯片"],
  }, taxonomy);
  assert.deepEqual([row.primaryTrack, row.secondaryTrack], ["可选消费", "家电"]);
});

test("an unmapped Eastmoney industry fails visibly", () => {
  assert.throws(() => classifyInstitutionalTrackRow({
    code: "TEST.SZ",
    name: "未知公司",
    industry: "未来新增行业",
    concepts: ["AI概念"],
  }, taxonomy), /unmapped exact Eastmoney industry/);
});
