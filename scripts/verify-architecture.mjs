#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unitSuffix = /\.test\.(?:mjs|js|ts|mts)$/;
const environmentTest = /(?:^|[./-])(?:smoke|live|e2e)(?:[./-]|$)/i;

/** Discover unit suites, never npm smoke scripts or live verification commands. */
export async function discoverUnitTests(projectRoot = root) {
  const included = [];
  const excluded = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".git", "fixtures"].includes(entry.name)) await walk(file);
      } else if (unitSuffix.test(entry.name)) {
        const name = relative(projectRoot, file).split("\\").join("/");
        (environmentTest.test(name) ? excluded : included).push(name);
      }
    }
  }
  for (const directory of ["src", "web/src", "scripts"]) await walk(join(projectRoot, directory));
  return { included: included.sort(), excluded: excluded.sort() };
}

/**
 * Tests and imported modules resolve fixtures relative to their source, not
 * their temporary bundle. Define these expressions per module (a single
 * bundle-wide define would incorrectly relocate every dependency).
 */
function preserveModuleLocations() {
  return {
    name: "original-module-locations",
    setup(builder) {
      builder.onLoad({ filter: /\.(?:mjs|cjs|js|ts|mts)$/ }, async ({ path }) => {
        if (path.includes(`${join("", "node_modules")}/`)) return undefined;
        const source = await readFile(path, "utf8");
        const result = await transform(source, {
          loader: /\.(?:ts|mts)$/.test(path) ? "ts" : "js",
          format: "esm",
          target: "node22",
          sourcefile: path,
          sourcemap: "inline",
          define: {
            "import.meta.url": JSON.stringify(pathToFileURL(path).href),
            "import.meta.dirname": JSON.stringify(dirname(path)),
            "import.meta.filename": JSON.stringify(path),
          },
        });
        return { contents: result.code, loader: "js", resolveDir: dirname(path) };
      });
    },
  };
}

export async function bundleUnitTest(source, outfile, { projectRoot = root, bindingsSource } = {}) {
  const plugins = [];
  if (bindingsSource) {
    plugins.push({
      name: "isolated-node-bindings",
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)data\/local\/runtime\/bindings\.mjs$/ }, () => ({ path: bindingsSource }));
      },
    });
  }
  plugins.push(preserveModuleLocations());
  await build({
    absWorkingDir: projectRoot,
    entryPoints: [resolve(projectRoot, source)],
    outfile,
    bundle: true,
    platform: "node",
  alias: { "cloudflare:sockets": resolve(projectRoot, "src/platform/node/sockets.ts") },
    // Frontend production/local identity is injected by Vite in normal builds.
    // Unit bundles bypass Vite, so supply the same local-runtime value here.
    define: { __STOCK_INFO_APP_RUNTIME__: JSON.stringify("node") },
    format: "esm",
    target: "node22",
    // In particular, esbuild cannot itself be bundled into a test. Keeping
    // package imports intact also preserves native binaries and package URLs.
    packages: "external",
    sourcemap: "inline",
    logLevel: "warning",
    plugins,
  });
}

function run(args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...options.env },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveResult();
      else reject(new Error(`Command failed (${signal || code}): node ${args.join(" ")}`));
    });
  });
}

async function main() {
  const manifest = await discoverUnitTests();
  if (process.argv.includes("--list")) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  const failures = [];
  async function gate(name, action) {
    console.log(`\n[verify] ${name}`);
    try { await action(); }
    catch (error) {
      failures.push({ name, message: error instanceof Error ? error.message : String(error) });
      console.error(`[verify] FAILED: ${name}: ${failures.at(-1).message}`);
    }
  }

  // Generated prompts are a compile input, never a network or LLM operation.
  await gate("Generate prompt inputs", () => run(["scripts/build-prompts.mjs"]));
  for (const [name, args] of [
    ["Backend types", ["node_modules/typescript/bin/tsc", "--noEmit"]],
    ["Frontend types", ["node_modules/vue-tsc/bin/vue-tsc.js", "--noEmit", "-p", "web/tsconfig.json"]],
    ["Frontend test types", ["node_modules/vue-tsc/bin/vue-tsc.js", "--noEmit", "-p", "web/tsconfig.test.json"]],
    ["Schema guard", ["scripts/check-no-new-tables.mjs"]],
    ["Local runtime guard", ["scripts/check-no-wrangler-local.mjs"]],
    ["Prompt boundary guard", ["scripts/check-no-inline-prompts.mjs"]],
    ["Runtime and page boundaries", ["scripts/check-runtime-boundaries.mjs"]],
    ["Release input lock", ["scripts/check-release-inputs.mjs"]],
  ]) await gate(name, () => run(args));

  const directory = await mkdtemp(join(tmpdir(), "stock-info-architecture-"));
  try {
    // ESM externals resolve from the temporary test bundle's node_modules.
    await symlink(resolve(root, "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
    const worker = join(directory, "sqlite-worker.mjs");
    await gate("Build isolated SQLite worker", () => build({
      absWorkingDir: root,
      entryPoints: ["src/platform/node/sqlite-worker.ts"],
      outfile: worker,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      logLevel: "warning",
    }));
    const suites = [];
    for (const [index, source] of manifest.included.entries()) {
      // Script suites already use native ESM and may invoke their own build
      // tools. Run them in place, except the adapter suite whose old runtime
      // artifact import is redirected to current source inside a fresh bundle.
      const bindingsTest = source === "scripts/local-node-bindings.test.mjs";
      if (source.startsWith("scripts/") && !bindingsTest && [".mjs", ".js"].includes(extname(source))) {
        suites.push(resolve(root, source));
        continue;
      }
      const outfile = join(directory, `${String(index).padStart(3, "0")}-${source.replaceAll("/", "-").replace(unitSuffix, "")}.test.mjs`);
      await gate(`Prepare ${source}`, async () => {
        await bundleUnitTest(source, outfile, {
          bindingsSource: bindingsTest ? resolve(root, "src/platform/node/local-bindings.ts") : undefined,
        });
        suites.push(outfile);
      });
    }
    console.log(`\n[verify] Running ${suites.length}/${manifest.included.length} unit suites; ${manifest.excluded.length} environment suites excluded.`);
    if (manifest.excluded.length) console.log(manifest.excluded.join("\n"));
    if (!suites.length) failures.push({ name: "Unit suites", message: "No unit suites were discovered/prepared" });
    else await gate("All unit suites", () => run([
      "--enable-source-maps", "--test", "--test-concurrency=1", "--test-timeout=120000", ...suites,
    ], { env: { LOCAL_SQLITE_WORKER_PATH: worker } }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log("\n[verify] Page smoke, live API/LLM, deployed Worker, and browser acceptance run separately against the chosen environment.");
  if (failures.length) {
    console.error(`[verify] ${failures.length} failed gates:\n${failures.map(({ name, message }) => `- ${name}: ${message}`).join("\n")}`);
    process.exitCode = 1;
  } else console.log("[verify] All architecture gates and unit suites passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
