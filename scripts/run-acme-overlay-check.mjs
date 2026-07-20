import { existsSync, rmSync } from 'node:fs';
import { LuxSqlite } from '../dist/db/sqlite-adapter.js';
import { LuxDatabase } from '../dist/db/index.js';
import { rebuildWithOverlay } from '../dist/scanner/rebuild-orchestrator.js';

const rootPath = '/path/to/auctic-core/vcs';
const dbPath = '/tmp/lux-auctic-module-routes.db';

if (existsSync(dbPath)) rmSync(dbPath, { force: true });

const luxDb = new LuxDatabase(dbPath);

console.log('[scan] running canonical overlay rebuild...');
const { result, scanResult } = await rebuildWithOverlay(luxDb, rootPath, {
  onProgress: (msg) => console.log(`[scan] ${msg}`),
});

console.log('[scan-stats]', JSON.stringify(scanResult.stats));
console.log('[overlay-result]', JSON.stringify(result));
luxDb.close();

const db = new LuxSqlite(dbPath, { readonly: true });
const count = (sql) => db.prepare(sql).get().count;

const counts = {
  totalSurfaces: count(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
  `),
  externalApiSurfaces: count(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and json_extract(metadata, '$.path') like '/api/external/%'
  `),
  providerDeclaredSurfaces: count(`
    select count(*) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and file_path like '%Provider.php'
  `),
  providerDeclaredDistinctFiles: count(`
    select count(distinct file_path) as count
    from structural_nodes
    where node_type = 'capability-surface'
      and file_path like '%Provider.php'
  `),
};

const providerFiles = db.prepare(`
  select file_path, count(*) as surfaces
  from structural_nodes
  where node_type = 'capability-surface'
    and file_path like '%Provider.php'
  group by file_path
  order by surfaces desc, file_path asc
`).all();

const externalSample = db.prepare(`
  select file_path, symbol_name, json_extract(metadata, '$.path') as path,
         json_extract(metadata, '$.explicitProvider') as provider,
         json_extract(metadata, '$.routeName') as route_name
  from structural_nodes
  where node_type = 'capability-surface'
    and json_extract(metadata, '$.path') like '/api/external/%'
  order by path asc
  limit 50
`).all();

console.log('[counts]', JSON.stringify(counts));
console.log('[provider-files]', JSON.stringify(providerFiles));
console.log('[external-sample]', JSON.stringify(externalSample));

db.close();
