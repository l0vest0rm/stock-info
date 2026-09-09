import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { bundleUnitTest, discoverUnitTests } from "./verify-architecture.mjs";

const execute = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(action) {
  // Node and esbuild canonicalize symlinks (macOS /var points to /private/var).
  const directory = await realpath(await mkdtemp(join(tmpdir(), "stock-info-verifier-contract-")));
  try { await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function put(root, name, content = "") {
  const target = join(root, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

test("unit discovery includes frontend and script suites without running live commands", async () => {
  await fixture(async (root) => {
    for (const name of [
      "src/module.test.ts", "src/more.test.mjs", "web/src/page.test.ts",
      "scripts/guard.test.mjs", "scripts/lib/helper.test.mjs",
      "scripts/smoke-pages.mjs", "src/api.live.test.mjs", "web/src/page.e2e.test.ts",
      "scripts/fixtures/nested.test.mjs",
    ]) await put(root, name);
    const result = await discoverUnitTests(root);
    assert.deepEqual(result.included, [
      "scripts/guard.test.mjs", "scripts/lib/helper.test.mjs", "src/module.test.ts",
      "src/more.test.mjs", "web/src/page.test.ts",
    ]);
    assert.deepEqual(result.excluded, ["src/api.live.test.mjs", "web/src/page.e2e.test.ts"]);
  });
});

test("bundling preserves each module's fixture URLs and leaves esbuild callable", async () => {
  await fixture(async (root) => {
    await symlink(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
    await put(root, "src/nested/fixture.txt", "nested fixture");
    await put(root, "src/nested/value.ts", `
      import { readFileSync } from 'node:fs';
      export const value: string = readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8');
      export const url = import.meta.url;
    `);
    await put(root, "src/entry.test.ts", `
      import assert from 'node:assert/strict';
      import { transform } from 'esbuild';
      import { value, url } from './nested/value';
      assert.equal(value, 'nested fixture');
      assert.equal(url, ${JSON.stringify(pathToFileURL(join(root, "src/nested/value.ts")).href)});
      assert.equal(import.meta.dirname, ${JSON.stringify(join(root, "src"))});
      assert.match((await transform('const n: number = 1', { loader: 'ts' })).code, /const n = 1/);
    `);
    await bundleUnitTest("src/entry.test.ts", join(root, "output.test.mjs"), { projectRoot: root });
    await execute(process.execPath, [join(root, "output.test.mjs")], { cwd: root });
  });
});
