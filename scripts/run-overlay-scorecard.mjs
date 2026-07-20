import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LuxSqlite } from '../dist/db/sqlite-adapter.js';

const [luxRepoPath, targetRepoPath, dbPath] = process.argv.slice(2);
if (!luxRepoPath || !targetRepoPath || !dbPath) {
  console.error('usage: node scripts/run-overlay-scorecard.mjs <luxRepoPath> <targetRepoPath> <dbPath>');
  process.exit(1);
}

if (existsSync(dbPath)) rmSync(dbPath, { force: true });

const { LuxDatabase } = await import(pathToFileURL(join(luxRepoPath, 'dist/db/index.js')).href);
const { rebuildWithOverlay } = await import(pathToFileURL(join(luxRepoPath, 'dist/scanner/rebuild-orchestrator.js')).href);

const luxDb = new LuxDatabase(dbPath);
await rebuildWithOverlay(luxDb, targetRepoPath);
luxDb.close();

const db = new LuxSqlite(dbPath, { readonly: true });
const get = (sql) => db.prepare(sql).get();
const all = (sql) => db.prepare(sql).all();

const scorecard = {
  totalSurfaces: get(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
  `).count,
  withProviders: get(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and json_extract(metadata, '$.explicitProvider') is not null
  `).count,
  providerDeclaredSurfaces: get(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and file_path like '%Provider.php'
  `).count,
  providerDeclaredDistinctFiles: get(`
    select count(distinct file_path) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and file_path like '%Provider.php'
  `).count,
  externalApiProviderSurfaces: get(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and file_path = 'src/Module/ExternalApi/RouteServiceProvider.php'
  `).count,
  externalApiCanonical: get(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and file_path = 'src/Module/ExternalApi/RouteServiceProvider.php'
      and json_extract(metadata, '$.path') like '/api/external/v1/%'
  `).count,
  externalApiUnprefixed: get(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and file_path = 'src/Module/ExternalApi/RouteServiceProvider.php'
      and json_extract(metadata, '$.path') not like '/api/external/v1/%'
  `).count,
  externalApiNamedRoutes: get(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and file_path = 'src/Module/ExternalApi/RouteServiceProvider.php'
      and json_extract(metadata, '$.routeName') is not null
  `).count,
};

const topProviderFiles = all(`
  select file_path, count(*) as surfaces
  from structural_nodes
  where node_type = 'capability-surface'
    and file_path like '%Provider.php'
  group by file_path
  order by surfaces desc, file_path asc
  limit 10
`);

const externalApiSample = all(`
  select symbol_name,
         json_extract(metadata, '$.path') as path,
         json_extract(metadata, '$.explicitProvider') as provider,
         json_extract(metadata, '$.routeName') as routeName
  from structural_nodes
  where node_type = 'capability-surface'
    and file_path = 'src/Module/ExternalApi/RouteServiceProvider.php'
  order by path asc, symbol_name asc
  limit 8
`);

console.log(JSON.stringify({ scorecard, topProviderFiles, externalApiSample }, null, 2));
db.close();
