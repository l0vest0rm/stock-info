#!/usr/bin/env node
// Development-only contract inventory. This is not a backend runtime and does
// not claim that matching method/path registrations prove behavioral parity.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--write', '--self-test', '--json', '--help'].includes(arg))) throw new Error('Unknown route-audit option');
if (args.has('--help')) {
  console.log('Usage: node scripts/check-rust-route-parity.mjs [--write] [--json] [--self-test]\nAudits local TypeScript route contracts, mounted Rust Router composition, content routes and active frontend API references. --write records docs/rust-route-parity.json. No HTTP calls or database changes.');
  process.exit(0);
}

const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL']);
const read = file => readFileSync(resolve(root, file), 'utf8');
const rel = file => relative(root, file).replaceAll('\\', '/');
const walk = dir => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)]) : [];
const joinPath = (prefix, path) => `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`.replace(/\/$/, '') || '/';
const canonical = path => path.split(/[?#]/)[0].replace(/\{\*\w+\}|:\w+\*/g, '*').replace(/\{\w+\}|:\w+/g, ':segment').replace(/\/$/, '') || '/';
const key = route => `${route.listener ?? 'http'} ${route.method} ${canonical(route.path)}`;
const sortRoutes = routes => routes.sort((a, b) => key(a).localeCompare(key(b)) || a.source.localeCompare(b.source));
function dedup(routes) { return sortRoutes([...new Map(routes.map(route => [key(route), route])).values()]); }
function covers(candidate, expected) {
  if ((candidate.listener ?? 'http') !== (expected.listener ?? 'http')) return false;
  if (candidate.method !== 'ALL' && candidate.method !== expected.method && !(candidate.method === 'GET' && expected.method === 'HEAD')) return false;
  const actual = canonical(candidate.path), wanted = canonical(expected.path);
  if (actual === wanted) return true;
  // A wildcard cannot stand in for a missing business handler: only explicit
  // wildcard contracts (retired auth/scheduler/content) use this comparison.
  const a = actual.split('/'), b = wanted.split('/');
  return a.length === b.length && a.every((segment, index) => segment === b[index] || segment === ':segment');
}

function tsSource(file) { return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, extname(file) === '.js' || extname(file) === '.mjs' ? ts.ScriptKind.JS : ts.ScriptKind.TS); }
function literal(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => ':segment' + span.literal.text).join('');
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return literal(node.left);
  return null;
}
function visit(node, callback) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
function resolveTsImport(file, name) {
  if (!name.startsWith('.')) return null;
  const path = resolve(dirname(resolve(root, file)), name);
  return [path, `${path}.ts`, `${path}.mjs`, `${path}.js`, resolve(path, 'index.ts')].find(existsSync) ?? null;
}

function legacyInventory() {
  const symbols = new Map();
  function load(file) {
    file = rel(resolve(root, file));
    const source = tsSource(file), imports = new Map();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const dependency = resolveTsImport(file, statement.moduleSpecifier.text);
      if (!dependency) continue;
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) imports.set(item.name.text, { file: rel(dependency), name: (item.propertyName ?? item.name).text });
    }
    const declarations = new Map();
    visit(source, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression)) return;
      const owner = node.expression.expression.text, method = node.expression.name.text;
      if (![...methods].map(method => method.toLowerCase()).includes(method) && method !== 'route') return;
      if (!node.arguments.length) return;
      const path = literal(node.arguments[0]);
      if (path === null || !path.startsWith('/')) return;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const record = { path, source: `${file}:${line}` };
      if (method === 'route') {
        const target = node.arguments[1];
        if (!target || !ts.isIdentifier(target)) throw new Error(`Unsupported dynamic Hono mount: ${record.source}`);
        record.mount = imports.get(target.text) ?? { file, name: target.text };
      } else record.method = method.toUpperCase();
      if (!declarations.has(owner)) declarations.set(owner, []);
      declarations.get(owner).push(record);
    });
    for (const [name, routes] of declarations) symbols.set(`${file}:${name}`, routes);
    return declarations;
  }
  const loaded = new Set();
  const expand = (file, name, prefix, seen = new Set()) => {
    if (!loaded.has(file)) { loaded.add(file); load(file); }
    const id = `${file}:${name}`;
    if (seen.has(id)) throw new Error(`Circular Hono route mount: ${id}`);
    return (symbols.get(id) ?? []).flatMap(route => route.mount
      ? expand(route.mount.file, route.mount.name, joinPath(prefix, route.path), new Set([...seen, id]))
      : [{ listener: 'http', ...route, path: joinPath(prefix, route.path) }]);
  };
  const routes = expand('src/app/router.ts', 'app', '');
  // Production-only ingress/auth are intentionally absent from the local app,
  // not silently accepted missing business APIs. Their source predicates are
  // checked so an unrelated route can never enter this exception by filename.
  const excluded = routes.filter(route => route.path.startsWith('/api/auth/') || route.path === '/api/internal/report-sync');
  assert.match(read('src/modules/auth/auth.ts'), /if\s*\(isLocalDevelopmentRuntime\(c\.env\)\)\s*return\s+c\.json\([\s\S]{0,100}?404\)/);
  assert.match(read('src/modules/report-sync/api/report-sync.routes.ts'), /APP_RUNTIME\s*!==\s*["']cloudflare["'][\s\S]{0,100}?404/);
  return { routes: routes.filter(route => !excluded.includes(route)), excluded: excluded.map(route => ({ ...route, reason: route.path.startsWith('/api/auth/') ? 'Already returns404 in the supported local runtime; Rust must not expose a login surface.' : 'Cloudflare-only report publication ingress; retired by the local-only requirement.' })) };
}

// Preserve positions but mask strings/comments/character literals. This small
// lexical scanner is deliberately narrower than a Rust parser; unsupported
// dynamic routes cause an error rather than being quietly ignored.
function maskRust(text) {
  const chars = text.split(''), strings = new Map();
  let i = 0;
  const blank = (start, end) => { for (let k = start; k < end; k++) if (chars[k] !== '\n') chars[k] = ' '; };
  while (i < text.length) {
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end; blank(i, stop); i = stop; continue; }
    if (text.startsWith('/*', i)) {
      const start = i; i += 2; let depth = 1;
      while (i < text.length && depth) { if (text.startsWith('/*', i)) { depth++; i += 2; } else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      if (depth) throw new Error('Unterminated Rust comment');
      blank(start, i); continue;
    }
    const raw = /^r(#+)?"/.exec(text.slice(i));
    if (raw) {
      const endMarker = `"${raw[1] ?? ''}`, end = text.indexOf(endMarker, i + raw[0].length);
      if (end < 0) throw new Error('Unterminated Rust raw string');
      strings.set(i, text.slice(i + raw[0].length, end));
      const stop = end + endMarker.length; blank(i, stop); i = stop; continue;
    }
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === '"') break; }
      let value;
      try { value = JSON.parse(text.slice(start, i)); } catch { value = null; }
      strings.set(start, value); blank(start, i); continue;
    }
    // Rust lifetimes start with apostrophes too; mask only closed char literals.
    const char = /^'(?:\\.|[^'\\\n])'/.exec(text.slice(i));
    if (char) { blank(i, i + char[0].length); i += char[0].length; continue; }
    i++;
  }
  return { text, mask: chars.join(''), strings };
}
function matching(mask, start, open = '(', close = ')') {
  let depth = 0;
  for (let i = start; i < mask.length; i++) { if (mask[i] === open) depth++; if (mask[i] === close && --depth === 0) return i; }
  throw new Error(`Unbalanced ${open}${close} at ${start}`);
}
function splitArguments(mask, start, end) {
  const slices = []; let left = start, stack = [];
  for (let i = start; i < end; i++) {
    if ('([{'.includes(mask[i])) stack.push(mask[i]);
    else if (')]}'.includes(mask[i])) stack.pop();
    else if (mask[i] === ',' && !stack.length) { slices.push([left, i]); left = i + 1; }
  }
  if (mask.slice(left, end).trim()) slices.push([left, end]);
  return slices;
}
function stringArgument(lex, start, end) {
  const values = [...lex.strings].filter(([position]) => position >= start && position < end);
  return values.length === 1 ? values[0][1] : null;
}
function moduleName(file) { return file.replace(/^backend\/src\//, '').replace(/\.rs$/, '').replace(/\/mod$/, '').split('/').filter(name => name !== 'lib'); }

function rustInventory(sources = null) {
  const functions = new Map(), lexers = new Map();
  const sourceFiles = sources ? [...sources.keys()] : walk(resolve(root, 'backend/src')).filter(file => file.endsWith('.rs')).map(rel);
  const readSource = file => sources ? sources.get(file) : read(file);
  for (const file of sourceFiles) {
    const lex = maskRust(readSource(file)); lexers.set(file, lex);
    const pattern = /\bfn\s+(\w+)\s*(?:<[^{};]*>)?\s*\(/g;
    for (const found of lex.mask.matchAll(pattern)) {
      const params = lex.mask.indexOf('(', found.index), paramEnd = matching(lex.mask, params);
      const start = lex.mask.indexOf('{', paramEnd);
      if (start < 0 || lex.mask.slice(paramEnd, start).includes(';')) continue;
      const end = matching(lex.mask, start, '{', '}');
      const id = [...moduleName(file), found[1]].join('::');
      // Test/impl methods cannot supply top-level Router exports; reject only
      // duplicate actual route-root names, not unrelated methods named read.
      if (!functions.has(id)) functions.set(id, { file, lex, start: start + 1, end });
    }
  }
  function expression(id, start, end, seen, variables = new Map()) {
    const fn = functions.get(id), { lex, file } = fn;
    const routes = [];
    const input = lex.mask.slice(start, end);
    // Root router stores /api in a local Router before nesting it. Remove the
    // declaration from the outer builder so its paths are not double-counted.
    const exclusions = [];
    for (const found of input.matchAll(/\blet\s+(?:mut\s+)?(\w+)\s*(?::[^=;]+)?=/g)) {
      const position = start + found.index;
      if (braceDepth(lex.mask, start, position) !== 0) continue;
      const left = position + found[0].length;
      let right = left, depth = [];
      for (; right < end; right++) {
        const c = lex.mask[right];
        if ('([{'.includes(c)) depth.push(c); else if (')]}'.includes(c)) depth.pop();
        if (c === ';' && !depth.length) break;
      }
      variables.set(found[1], [left, right]); exclusions.push([position, right + 1]);
    }
    // A router-returning function may be the base of a further builder chain,
    // e.g. knowledge::content_routes().route(...). Preserve that mounted base.
    const outer = input.split('');
    for (const [a, b] of exclusions) for (let offset = a - start; offset < b - start; offset++) outer[offset] = ' ';
    const tail = outer.join(''), baseCall = /^\s*(?:return\s+)?((?:\w+::)*\w+)\s*\(/.exec(tail);
    if (baseCall && baseCall[1] !== 'Router::new') {
      const offset = tail.indexOf(baseCall[1]);
      routes.push(...resolveExpression(id, [start + offset, end], seen, variables));
    }
    for (const call of input.matchAll(/\.(route|nest|merge)\s*\(/g)) {
      const position = start + call.index;
      if (exclusions.some(([a, b]) => position >= a && position < b) || braceDepth(lex.mask, start, position) !== 0) continue;
      const open = lex.mask.indexOf('(', position), close = matching(lex.mask, open);
      const slices = splitArguments(lex.mask, open + 1, close);
      const source = `${file}:${lex.text.slice(0, position).split('\n').length}`;
      if (call[1] === 'route') {
        const path = stringArgument(lex, ...slices[0]);
        if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`Dynamic Rust route requires audit support: ${source}`);
        if (!slices[1]) throw new Error(`Missing Rust method router: ${source}`);
        const [a, b] = slices[1], builder = lex.mask.slice(a, b), foundMethods = new Set();
        for (const method of builder.matchAll(/\b(get|post|put|patch|delete|head|options|any)(?:_service)?\s*\(/g)) {
          if (braceDepth(builder, 0, method.index) !== 0) continue;
          foundMethods.add(method[1] === 'any' ? 'ALL' : method[1].toUpperCase());
        }
        if (!foundMethods.size) throw new Error(`Unrecognized Rust method router: ${source}`);
        routes.push(...[...foundMethods].map(method => ({ listener: 'http', method, path, source })));
      } else {
        const target = call[1] === 'nest' ? slices[1] : slices[0];
        if (!target) throw new Error(`Unrecognized Rust mount: ${source}`);
        let nested = resolveExpression(id, target, seen, variables);
        if (call[1] === 'nest') {
          const prefix = stringArgument(lex, ...slices[0]);
          if (typeof prefix !== 'string') throw new Error(`Dynamic Rust mount requires audit support: ${source}`);
          nested = nested.map(route => ({ ...route, path: joinPath(prefix, route.path) }));
        }
        routes.push(...nested);
      }
    }
    return routes;
  }
  function resolveExpression(id, range, seen, variables) {
    const fn = functions.get(id), value = fn.lex.mask.slice(...range).trim();
    if (variables.has(value)) return expression(id, ...variables.get(value), seen, variables);
    const call = /^((?:crate::|self::|super::)?(?:\w+::)*\w+)\s*\(/.exec(value);
    if (!call) throw new Error(`Unsupported Rust Router mount expression in ${fn.file}: ${value.slice(0, 100)}`);
    const segments = call[1].split('::'), base = moduleName(fn.file);
    if (segments[0] === 'crate') { segments.shift(); base.length = 0; }
    else if (segments[0] === 'self') segments.shift();
    else while (segments[0] === 'super') { segments.shift(); base.pop(); }
    const target = [...base, ...segments].join('::');
    if (!functions.has(target)) throw new Error(`Mounted Rust router has no definition yet: ${target} (from ${fn.file})`);
    return expand(target, seen);
  }
  function expand(id, seen = new Set()) {
    if (seen.has(id)) throw new Error(`Circular Rust Router mount: ${id}`);
    const fn = functions.get(id);
    if (!fn) throw new Error(`Missing Rust Router root: ${id}`);
    return expression(id, fn.start, fn.end, new Set([...seen, id]));
  }
  const mounted = expand('router');
  let content = [];
  if (functions.has('content_router')) content = expand('content_router').map(route => ({ ...route, listener: 'content' }));
  const defined = [];
  for (const id of functions.keys()) if (/::(?:routes|page_routes|content_routes)$/.test(id)) {
    const content = id === 'knowledge::content::routes' || id.endsWith('::content_routes');
    const prefix = id.endsWith('::routes') && !content ? '/api' : '';
    for (const route of expand(id)) defined.push({ ...route, listener: content ? 'content' : route.listener, path: joinPath(prefix, route.path), definedBy: id });
  }
  const hasStaticAssets = /fallback_service\s*\(\s*ServeDir::new\(assets\)/.test(readSource('backend/src/lib.rs'));
  const assets = hasStaticAssets ? JSON.parse(read('config/app/page-manifest.json')).filter(page => page.path !== '/login.html').map(page => ({ listener:'http', method:'GET', path:page.path, source:'config/app/page-manifest.json (ServeDir fallback)' })) : [];
  return { mounted: dedup([...assets, ...mounted, ...content]), defined: dedup(defined), hasStaticAssets };
}
function braceDepth(mask, start, end) {
  let depth = 0;
  for (let i = start; i < end; i++) { if (mask[i] === '{') depth++; else if (mask[i] === '}') depth--; }
  return depth;
}

function specialContracts() {
  // These paths are dispatched before Hono, so an API-only scan loses them.
  // Tie every explicit inventory entry to the owning source, without claiming
  // that these literal guards prove each handler's validation/body behavior.
  const server = read('src/platform/node/local-server.ts');
  assert(server.includes('/api/local/information-feed/rejected'));
  const callback = read('scripts/lib/sub2me-callback.mjs');
  assert(callback.includes('/api/local/sub2me/callback') && callback.includes('request.method !== "POST"'));
  const featured = read('scripts/lib/featured-report-local.mjs');
  assert(featured.includes('/__review') && featured.includes('original\\.pdf|content\\.json'));
  const content = read('scripts/local-knowledge-content-server.mjs');
  for (const path of ['/__health', '/__convert-report', '/__convert-sec-filing', '/knowledge-content/', '/featured-reports/']) assert(content.includes(path));
  return [
    { listener: 'http', method: 'GET', path: '/api/local/information-feed/rejected', source: 'src/platform/node/local-server.ts' },
    { listener: 'http', method: 'POST', path: '/api/local/sub2me/callback', source: 'scripts/lib/sub2me-callback.mjs' },
    ...['original.pdf', 'content.json'].flatMap(artifact => ['GET', 'HEAD'].map(method => ({ listener: 'http', method, path: `/__review/:code/${artifact}`, source: 'scripts/lib/featured-report-local.mjs' }))),
    { listener: 'http', method: 'ALL', path: '/__review/:code/save', source: 'scripts/lib/featured-report-review.mjs' },
    { listener: 'content', method: 'GET', path: '/__health', source: 'scripts/local-knowledge-content-server.mjs' },
    ...['/__convert-report', '/__convert-sec-filing'].map(path => ({ listener: 'content', method: 'POST', path, source: 'scripts/local-knowledge-content-server.mjs' })),
    ...['/knowledge-content/*', '/featured-reports/*'].flatMap(path => ['GET', 'HEAD', 'OPTIONS'].map(method => ({ listener: 'content', method, path, source: 'scripts/local-knowledge-content-server.mjs' }))),
  ];
}

function frontendPaths(expression, constants = new Map(), seen = new Set()) {
  if (ts.isParenthesizedExpression(expression)) return frontendPaths(expression.expression, constants, seen);
  if (ts.isIdentifier(expression) && constants.has(expression.text) && !seen.has(expression.text)) {
    return frontendPaths(constants.get(expression.text), constants, new Set([...seen, expression.text]));
  }
  if (ts.isConditionalExpression(expression)) return [...frontendPaths(expression.whenTrue, constants, seen), ...frontendPaths(expression.whenFalse, constants, seen)];
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = frontendPaths(expression.left, constants, seen), right = frontendPaths(expression.right, constants, seen);
    return left.flatMap(a => right.map(b => a + b));
  }
  if (ts.isTemplateExpression(expression)) {
    let values = [expression.head.text];
    for (const span of expression.templateSpans) {
      const parts = frontendPaths(span.expression, constants, seen);
      values = values.flatMap(value => parts.map(part => value + part + span.literal.text));
    }
    return values;
  }
  return [ts.isStringLiteralLike(expression) ? expression.text : ':segment'];
}

function frontendReferences() {
  const pages = JSON.parse(read('config/app/page-manifest.json')).filter(page => page.path !== '/login.html');
  const active = new Set(), references = [];
  function scan(file) {
    file = rel(resolve(root, file));
    if (active.has(file)) return;
    active.add(file);
    const source = tsSource(file), constants = new Map();
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    visit(source, node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const dependency = resolveTsImport(file, node.moduleSpecifier.text);
        if (dependency && /\.(?:ts|mjs|js)$/.test(dependency)) scan(dependency);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const dependency = resolveTsImport(file, node.arguments[0].text);
        if (dependency && /\.(?:ts|mjs|js)$/.test(dependency)) scan(dependency);
      }
      if (!ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node) && !ts.isBinaryExpression(node)) return;
      if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return;
      const paths = frontendPaths(node, constants).filter(path => path.startsWith('/api/'));
      if (!paths.length) return;
      if (ts.isStringLiteralLike(node) && (ts.isTemplateExpression(node.parent) || ts.isTemplateSpan(node.parent))) return;
      let method = 'UNSPECIFIED';
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
        const expressionName = parent.expression.getText(source);
        if (/\b(?:post|apiPost)$/i.test(expressionName)) method = 'POST';
        else if (/\b(?:get|apiGet|fetch|getJson|fetchJson|request)$/i.test(expressionName)) method = 'GET';
        const options = parent.arguments[1];
        if (options && ts.isObjectLiteralExpression(options)) {
          const setting = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source).replaceAll(/["']/g, '') === 'method');
          if (setting) method = literal(setting.initializer)?.toUpperCase() ?? 'UNSPECIFIED';
        }
      }
      for (const path of paths) references.push({ listener: 'http', method, path: path.split(/[?#]/)[0], source: `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}` });
    });
  }
  for (const page of pages) if (page.entry) scan(`web/${page.entry}`);
  scan('web/src/app/layout/index.ts');
  if (pages.some(page => page.legacy)) scan('web/src/legacy-page-init.ts');
  return { files: [...active].sort(), references: dedup(references) };
}

function selfTest() {
  assert.equal(canonical('/api/research/:code/test'), canonical('/api/research/{security_code}/test'));
  assert.equal(canonical('/api/llm-tasks/*'), canonical('/api/llm-tasks/{*path}'));
  assert(covers({ method: 'GET', path: '/x/{code}' }, { method: 'GET', path: '/x/:id' }));
  assert(!covers({ method: 'GET', path: '/x/{code}' }, { method: 'POST', path: '/x/:id' }));
  assert(covers({ method: 'GET', path: '/finance/{kind}' }, { method: 'GET', path: '/finance/income' }));
  assert(!covers({ method: 'GET', path: '/finance/income' }, { method: 'GET', path: '/finance/:kind' }));
  assert(!covers({ method: 'GET', path: '/api/{*path}' }, { method: 'GET', path: '/api/finance/income' }));
  const lex = maskRust('/* .route("/fake", post(x)) */ fn routes(){ Router::new().route("/real/{code}", get(read).post(write)) }');
  assert.equal([...lex.strings.values()].join(','), '/real/{code}');
  const call = lex.mask.indexOf('.route'), open = lex.mask.indexOf('(', call), close = matching(lex.mask, open);
  const parts = splitArguments(lex.mask, open + 1, close);
  assert.equal(stringArgument(lex, ...parts[0]), '/real/{code}');
  assert.equal(parts.length, 2);
  assert.equal(literal(ts.createSourceFile('fixture.ts', '`/api/x/${code}/history?${query}`', ts.ScriptTarget.Latest, true).statements[0].expression), '/api/x/:segment/history?:segment');
  const frontendFixture = ts.createSourceFile('fixture.ts', 'const server = ""; `${server}/api/x/${code}/history`; "/api/screen" + (refresh ? "/refresh" : "")', ts.ScriptTarget.Latest, true);
  const frontendConstants = new Map([['server', frontendFixture.statements[0].declarationList.declarations[0].initializer]]);
  assert.deepEqual(frontendPaths(frontendFixture.statements[1].expression, frontendConstants), ['/api/x/:segment/history']);
  assert.deepEqual(frontendPaths(frontendFixture.statements[2].expression), ['/api/screen/refresh', '/api/screen']);
  const fixture = new Map([
    ['backend/src/lib.rs', 'pub fn router(){ let api=Router::new().merge(stock::routes()).route("/health",get(health)); Router::new().nest("/api",api).route("/",get_service(ServeFile::new("home.html"))) } pub fn content_router(){let boundary=Boundary{}; stock::inner::routes().route("/options",options(opt))}'],
    ['backend/src/stock.rs', 'pub fn routes(){ Router::new().route(r#"/finance/{kind}"#,get(read).post(write)).merge(inner::routes()) }'],
    ['backend/src/stock/inner.rs', '/* 😀 .route("/fake",delete(fake)) */ pub fn routes(){ Router::new().route("/stock/{id}",get(||async { helper() })) }'],
    ['backend/src/unmounted.rs', 'pub fn routes(){ Router::new().route("/hidden",delete(secret)) }'],
  ]);
  const inventory = rustInventory(fixture);
  assert(inventory.mounted.some(route => key(route) === 'http POST /api/finance/:segment'));
  assert(inventory.mounted.some(route => key(route) === 'http GET /api/stock/:segment'));
  assert(inventory.mounted.some(route => key(route) === 'http GET /'));
  assert(inventory.mounted.some(route => key(route) === 'content GET /stock/:segment'));
  assert(inventory.mounted.some(route => key(route) === 'content OPTIONS /options'));
  assert(!inventory.mounted.some(route => route.path.includes('hidden') || route.path.includes('fake')));
  assert(inventory.defined.some(route => route.path === '/api/hidden'));
  const dynamic = new Map([['backend/src/lib.rs', 'pub fn router(){Router::new().route(path,get(read))}']]);
  assert.throws(() => rustInventory(dynamic), /Dynamic Rust route/);
  console.log('Route audit parser regressions passed.');
}

if (args.has('--self-test')) { selfTest(); process.exit(0); }
const legacy = legacyInventory(), rust = rustInventory();
const expected = dedup([...legacy.routes, ...specialContracts()]);
const missing = expected.filter(route => !rust.mounted.some(candidate => covers(candidate, route)));
const frontend = frontendReferences();
const frontendMissing = frontend.references.filter(route => {
  if (route.path.startsWith('/api/auth/')) return false;
  const method = route.method === 'UNSPECIFIED' ? null : route.method;
  return !rust.mounted.some(candidate => covers({ ...candidate, method: method === null ? 'ALL' : candidate.method }, { ...route, method: method ?? 'ALL' }));
});
const diagnostics = [];
if (/StatusCode::NOT_IMPLEMENTED/.test(read('backend/src/lib.rs'))) diagnostics.push('Root API fallback still returns501; final unknown APIs must return404 without HTML or migration stub responses.');
if (!rust.hasStaticAssets) diagnostics.push('Root static asset ServeDir fallback is absent or changed; audit must be updated explicitly.');
const result = {
  schemaVersion: 1,
  scope: 'Source-registration parity only; does not prove payload, arithmetic, authentication, provider, scheduler or UI behavior.',
  counts: { expected: expected.length, mountedRust: rust.mounted.length, definedRust: rust.defined.length, missing: missing.length, frontendReferences: frontend.references.length, frontendMissing: frontendMissing.length },
  expected, excludedProductionOnly: legacy.excluded, mountedRust: rust.mounted,
  missing: missing.map(route => ({ ...route, definedButNotMounted: rust.defined.filter(candidate => canonical(candidate.path) === canonical(route.path) && (candidate.method === route.method || candidate.method === 'ALL')) })),
  frontend: { ...frontend, missing: frontendMissing, unresolvedDynamicTails: frontendMissing.filter(route => route.path.endsWith(':segment')) },
  diagnostics,
};
if (args.has('--write')) writeFileSync(resolve(root, 'docs/rust-route-parity.json'), JSON.stringify(result, null, 2) + '\n');
if (args.has('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(JSON.stringify({ routeParity: missing.length || frontendMissing.length || diagnostics.length ? 'failed' : 'passed', ...result.counts }));
  for (const route of missing) console.error(`Missing mounted Rust contract: ${key(route)} (${route.source})`);
  for (const route of frontendMissing) console.error(`Frontend API reference has no mounted Rust contract: ${key(route)} (${route.source})`);
  for (const message of diagnostics) console.error(message);
}
if (missing.length || frontendMissing.length || diagnostics.length) process.exitCode = 1;
