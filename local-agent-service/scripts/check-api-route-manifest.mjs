import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(here, '..');
const manifest = JSON.parse(await readFile(resolve(serviceRoot, 'api-route-manifest.json'), 'utf8'));

assert.equal(manifest.version, 1, 'update this checker when the manifest format changes');
assert.ok(Array.isArray(manifest.routes) && manifest.routes.length > 0, 'route manifest must not be empty');

const sourceCache = new Map();
for (const route of manifest.routes) {
  assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method), `invalid method: ${route.method}`);
  assert.ok(route.path.startsWith('/'), `route path must be absolute: ${route.path}`);
  assert.ok(route.signature && route.source, `route must identify its implementation: ${route.method} ${route.path}`);

  let source = sourceCache.get(route.source);
  if (!source) {
    source = await readFile(resolve(serviceRoot, route.source), 'utf8');
    sourceCache.set(route.source, source);
  }
  assert.ok(
    source.includes(route.signature),
    `API route manifest drift: no longer found in ${route.source}: ${route.method} ${route.path} (signature: ${route.signature})`,
  );
}


const manifestBySource = new Map();
for (const route of manifest.routes) {
  const entries = manifestBySource.get(route.source) || [];
  entries.push(route);
  manifestBySource.set(route.source, entries);
}

// Reverse coverage: discover route-dispatch conditions in the implementation and
// require each one to be represented in the manifest. The existing forward check
// above catches stale signatures; this catches newly added handlers that forgot
// to update the manifest. This is intentionally a lightweight source check, not an AST.
//
// 分发入口可能分布在多个文件（总路由 + 各分组路由器），逐个文件按清单里登记的
// source 反查，避免新增分组路由器后校验静默失效。
const DISPATCH_SOURCES = ['src/routes.ts', 'src/localApiRoutes.ts', 'src/longTaskRoutes.ts'];
for (const dispatchSource of DISPATCH_SOURCES) {
  const source = sourceCache.get(dispatchSource);
  if (!source) continue;
  const routes = manifestBySource.get(dispatchSource) || [];
  for (const match of source.matchAll(/if\s*\(([\s\S]*?)\)\s*\{/g)) {
    const condition = match[1];
    if (!/req\.method\s*===/.test(condition) || !condition.includes('url.pathname')) continue;
    const method = condition.match(/req\.method\s*===\s*'([A-Z]+)'/)?.[1];
    assert.ok(method, `could not determine HTTP method from route condition: ${condition}`);
    assert.ok(
      routes.some((route) => route.method === method && condition.includes(route.signature)),
      `API route manifest is missing a handler in ${dispatchSource}: ${method} (${condition.trim()})`,
    );
  }
}

// The three one-shot literary/OpenAI endpoints are dispatched through the
// supported-method set rather than an outer req.method/pathname condition.
const longTaskSource = sourceCache.get('src/longTaskRoutes.ts');
assert.ok(longTaskSource, 'could not read src/longTaskRoutes.ts');
const longTaskRoutes = manifestBySource.get('src/longTaskRoutes.ts') || [];
const supportedBlock = longTaskSource.match(/const SUPPORTED_LONG_TASKS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(supportedBlock, 'could not locate supported endpoint set in src/longTaskRoutes.ts');
for (const match of supportedBlock[1].matchAll(/'([A-Z]+) (\/[^']+)'/g)) {
  const [, method, path] = match;
  assert.ok(
    longTaskRoutes.some((route) => route.method === method && route.path === path),
    `API route manifest is missing supported endpoint: ${method} ${path}`,
  );
}

const projectSource = sourceCache.get('src/documents/projectRoutes.ts');
const projectRoutes = manifestBySource.get('src/documents/projectRoutes.ts') || [];
const projectConditions = projectSource.matchAll(/if\s*\(([^)]*pathParts[^)]*)\)/g);
for (const match of projectConditions) {
  const condition = match[1];
  const method = condition.match(/method\s*===\s*'([A-Z]+)'/)?.[1];
  if (!method) continue; // Path guards are not endpoint handlers.
  assert.ok(
    projectRoutes.some((route) => route.method === method && condition.includes(route.signature)),
    `API route manifest is missing a handler in src/documents/projectRoutes.ts: ${method} (${condition.trim()})`,
  );
}

const identities = manifest.routes.map((route) => `${route.method} ${route.path}`);
assert.equal(new Set(identities).size, identities.length, 'duplicate method/path entries in API route manifest');

console.log(`API route manifest check passed: ${manifest.routes.length} route entries; source signatures are present.`);
console.log('Note: this checks inventory/source drift only, not full OpenAPI request/response schemas.');


// Validate the checked-in incremental OpenAPI contract and all local JSON Pointer refs.
// The contract intentionally declares partial coverage until every route has schemas.
const openapi = JSON.parse(await readFile(resolve(serviceRoot, 'openapi.json'), 'utf8'));
assert.equal(openapi.openapi, '3.1.0', 'OpenAPI contract must use a supported version');
assert.equal(openapi.info?.version, '1.0.0', 'OpenAPI info.version is required');
assert.equal(openapi['x-contract-coverage']?.status, 'partial',
  'do not claim full contract coverage while routes remain undocumented');
assert.ok(openapi.paths && Object.keys(openapi.paths).length > 0, 'OpenAPI must describe at least one endpoint');

function resolveJsonPointer(document, pointer) {
  assert.ok(pointer.startsWith('#/'), `only local JSON Pointer refs are supported: ${pointer}`);
  return pointer.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((value, key) => {
      assert.ok(value && Object.hasOwn(value, key), `unresolved OpenAPI ref: ${pointer}`);
      return value[key];
    }, document);
}
function visitRefs(value, location = 'openapi') {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') {
    resolveJsonPointer(openapi, value.$ref);
  }
  for (const [key, child] of Object.entries(value)) visitRefs(child, `${location}.${key}`);
}
visitRefs(openapi);
for (const [path, pathItem] of Object.entries(openapi.paths)) {
  assert.ok(path.startsWith('/'), `OpenAPI path must be absolute: ${path}`);
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = pathItem[method];
    if (!operation) continue;
    assert.ok(operation.responses && Object.keys(operation.responses).length > 0,
      `OpenAPI operation must define responses: ${method.toUpperCase()} ${path}`);
  }
}
assert.ok(openapi.paths['/api/documents/projects/{projectId}/runs'], 'Run collection contract is required');
assert.ok(openapi.paths['/api/documents/projects/{projectId}/runs/{runId}/resume'], 'Run resume contract is required');
assert.ok(openapi.paths['/api/documents/projects/{projectId}/runs/{runId}/cancel'], 'Run cancel contract is required');
console.log(`OpenAPI contract check passed: ${Object.keys(openapi.paths).length} paths; local refs resolve; coverage remains explicitly partial.`);


// Every route inventory entry must have a matching OpenAPI path + method. Operations
// with only generic request/response placeholders are explicitly labelled inventory-only.
const openapiMethod = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' };
assert.equal(openapi['x-contract-coverage']?.routeCount, manifest.routes.length,
  'OpenAPI routeCount must match the route manifest');
for (const route of manifest.routes) {
  const operation = openapi.paths?.[route.path]?.[openapiMethod[route.method]];
  assert.ok(operation, `OpenAPI is missing manifest route: ${route.method} ${route.path}`);
  if (operation['x-route-contract-level'] === 'inventory-only') {
    assert.equal(operation['x-implementation-source'], route.source,
      `OpenAPI implementation source drift: ${route.method} ${route.path}`);
    assert.equal(operation['x-implementation-signature'], route.signature,
      `OpenAPI implementation signature drift: ${route.method} ${route.path}`);
  }
}
