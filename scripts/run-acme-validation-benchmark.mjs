import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LuxSqlite } from '../dist/db/sqlite-adapter.js';
import { LuxDatabase } from '../dist/db/index.js';
import { rebuildWithOverlay } from '../dist/scanner/rebuild-orchestrator.js';

const [targetRepoPathArg, dbPathArg, benchmarkPathArg] = process.argv.slice(2);
const targetRepoPath = targetRepoPathArg ?? '/path/to/auctic-core/vcs';
const dbPath = dbPathArg ?? '/tmp/lux-auctic-validation-benchmark.db';
const benchmarkPath = benchmarkPathArg ?? new URL('./benchmarks/auctic-validation-benchmark.json', import.meta.url);

const benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf8'));

if (existsSync(dbPath)) rmSync(dbPath, { force: true });
mkdirSync(dirname(dbPath), { recursive: true });

const luxDb = new LuxDatabase(dbPath);
await rebuildWithOverlay(luxDb, targetRepoPath);
luxDb.close();

const db = new LuxSqlite(dbPath, { readonly: true });

const allSurfaces = db.prepare(`
  select id,
         file_path,
         symbol_name,
         json_extract(metadata, '$.path') as path,
         json_extract(metadata, '$.routeName') as route_name,
         upper(coalesce(json_extract(metadata, '$.method'), substr(symbol_name, 1, instr(symbol_name, ' ') - 1))) as method
  from structural_nodes
  where node_type = 'capability-surface'
`).all();

const surfacesByKey = new Map();
for (const surface of allSurfaces) {
  const key = `${surface.method} ${surface.path}`;
  if (!surfacesByKey.has(key)) surfacesByKey.set(key, []);
  surfacesByKey.get(key).push(surface);
}

const providerBySurfaceId = new Map(
  db.prepare(`
    select source_node_id as surface_id, target_node_id as provider_id
    from structural_edges
    where edge_type = 'handled_by'
  `).all().map((row) => [row.surface_id, row.provider_id])
);

const validatorProviderIds = new Set(
  db.prepare(`select distinct source_node_id as provider_id from structural_edges where edge_type = 'validates_with'`).all().map((row) => row.provider_id)
);

const responseProviderIds = new Set(
  db.prepare(`select distinct source_node_id as provider_id from structural_edges where edge_type = 'returns_contract'`).all().map((row) => row.provider_id)
);

const consumersBySurfaceId = new Map();
for (const row of db.prepare(`
  select e.target_node_id as surface_id, n.file_path as consumer_file
  from structural_edges e
  join structural_nodes n on n.id = e.source_node_id
  where e.edge_type = 'calls_surface'
    and e.confidence >= 0.75
`).all()) {
  if (!consumersBySurfaceId.has(row.surface_id)) consumersBySurfaceId.set(row.surface_id, new Set());
  consumersBySurfaceId.get(row.surface_id).add(row.consumer_file);
}

function evaluateSurface(surface) {
  const providerId = providerBySurfaceId.get(surface.id) ?? null;
  const consumerFiles = [...(consumersBySurfaceId.get(surface.id) ?? new Set())].sort();
  const hasProvider = providerId !== null;
  const hasValidator = providerId ? validatorProviderIds.has(providerId) : false;
  const hasResponse = providerId ? responseProviderIds.has(providerId) : false;
  const hasConsumer = consumerFiles.length > 0;
  const level = hasConsumer && hasProvider && hasValidator && hasResponse
    ? 'L5'
    : hasConsumer && hasProvider
      ? 'L4'
      : hasProvider && (hasValidator || hasResponse)
        ? 'L3'
        : hasProvider
          ? 'L2'
          : surface.id
            ? 'L1'
            : 'Miss';

  return {
    id: surface.id,
    filePath: surface.file_path,
    symbolName: surface.symbol_name,
    method: surface.method,
    path: surface.path,
    routeName: surface.route_name,
    hasProvider,
    hasValidator,
    hasResponse,
    consumerFiles,
    level,
  };
}

function matchesSelector(surface, selector) {
  if (selector.filePath && surface.file_path !== selector.filePath) return false;
  return true;
}

function summarizeCohort(cohort) {
  const matching = allSurfaces.filter((surface) => matchesSelector(surface, cohort.selector));
  const evaluated = matching.map(evaluateSurface);
  return {
    surfaces: evaluated.length,
    withProviders: evaluated.filter((s) => s.hasProvider).length,
    withProvenConsumers: evaluated.filter((s) => s.consumerFiles.length > 0).length,
    withValidators: evaluated.filter((s) => s.hasValidator).length,
    withResponses: evaluated.filter((s) => s.hasResponse).length,
    fullyStructured: evaluated.filter((s) => s.level === 'L5').length,
  };
}

function evaluateExemplar(exemplar) {
  const key = `${exemplar.method.toUpperCase()} ${exemplar.path}`;
  const candidates = (surfacesByKey.get(key) ?? []).map(evaluateSurface);
  if (exemplar.routeName) {
    const exactRoute = candidates.find((c) => c.routeName === exemplar.routeName);
    if (exactRoute) {
      return { ...exactRoute, targetLevel: exemplar.targetLevel, stretchLevel: exemplar.stretchLevel ?? null, expectedConsumerFiles: exemplar.consumerFiles ?? [] };
    }
  }
  const first = candidates[0];
  if (!first) {
    return {
      method: exemplar.method,
      path: exemplar.path,
      routeName: exemplar.routeName ?? null,
      level: 'Miss',
      hasProvider: false,
      hasValidator: false,
      hasResponse: false,
      consumerFiles: [],
      targetLevel: exemplar.targetLevel,
      stretchLevel: exemplar.stretchLevel ?? null,
      expectedConsumerFiles: exemplar.consumerFiles ?? [],
      filePath: null,
      symbolName: null,
    };
  }
  return { ...first, targetLevel: exemplar.targetLevel, stretchLevel: exemplar.stretchLevel ?? null, expectedConsumerFiles: exemplar.consumerFiles ?? [] };
}

const result = {
  benchmark: benchmark.name,
  targetRepoPath,
  cohorts: benchmark.cohorts.map((cohort) => ({
    id: cohort.id,
    label: cohort.label,
    tier: cohort.tier,
    kind: cohort.kind,
    description: cohort.description,
    summary: summarizeCohort(cohort),
    exemplars: cohort.exemplars.map(evaluateExemplar),
  })),
};

console.log(JSON.stringify(result, null, 2));
db.close();
