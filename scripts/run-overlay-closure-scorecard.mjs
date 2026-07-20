import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LuxSqlite } from '../dist/db/sqlite-adapter.js';

const [luxRepoPath, targetRepoPath, dbPath] = process.argv.slice(2);
if (!luxRepoPath || !targetRepoPath || !dbPath) {
  console.error('usage: node scripts/run-overlay-closure-scorecard.mjs <luxRepoPath> <targetRepoPath> <dbPath>');
  process.exit(1);
}

if (existsSync(dbPath)) rmSync(dbPath, { force: true });

const { LuxDatabase } = await import(pathToFileURL(join(luxRepoPath, 'dist/db/index.js')).href);
const { rebuildWithOverlay } = await import(pathToFileURL(join(luxRepoPath, 'dist/scanner/rebuild-orchestrator.js')).href);

const luxDb = new LuxDatabase(dbPath);
await rebuildWithOverlay(luxDb, targetRepoPath);
luxDb.close();

const db = new LuxSqlite(dbPath, { readonly: true });

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cohortMetrics(whereClause = '1=1') {
  const sql = `
    with cohort as (
      select
        id,
        file_path,
        symbol_name,
        upper(coalesce(json_extract(metadata, '$.method'), substr(symbol_name, 1, instr(symbol_name, ' ') - 1))) as method
      from structural_nodes
      where node_type = 'capability-surface'
        and ${whereClause}
    ),
    provider_edges as (
      select distinct c.id as surface_id, e.target_node_id as provider_id
      from cohort c
      join structural_edges e
        on e.source_node_id = c.id
       and e.edge_type = 'handled_by'
    ),
    any_consumers as (
      select distinct c.id as surface_id
      from cohort c
      join structural_edges e
        on e.target_node_id = c.id
       and e.edge_type = 'calls_surface'
    ),
    proven_consumers as (
      select distinct c.id as surface_id
      from cohort c
      join structural_edges e
        on e.target_node_id = c.id
       and e.edge_type = 'calls_surface'
       and e.confidence >= 0.75
    ),
    validators as (
      select distinct pe.surface_id
      from provider_edges pe
      join structural_edges e
        on e.source_node_id = pe.provider_id
       and e.edge_type = 'validates_with'
    ),
    exact_validators as (
      select distinct pe.surface_id
      from provider_edges pe
      join structural_edges e
        on e.source_node_id = pe.provider_id
       and e.edge_type = 'validates_with'
      join structural_nodes n
        on n.id = e.target_node_id
      where json_extract(n.metadata, '$.shapeConfidence') = 'exact'
    ),
    responses as (
      select distinct pe.surface_id
      from provider_edges pe
      join structural_edges e
        on e.source_node_id = pe.provider_id
       and e.edge_type = 'returns_contract'
    ),
    exact_responses as (
      select distinct pe.surface_id
      from provider_edges pe
      join structural_edges e
        on e.source_node_id = pe.provider_id
       and e.edge_type = 'returns_contract'
      join structural_nodes n
        on n.id = e.target_node_id
      where json_extract(n.metadata, '$.shapeConfidence') = 'exact'
    ),
    read_like as (
      select id as surface_id
      from cohort
      where method in ('GET', 'HEAD', 'OPTIONS')
    ),
    mutating as (
      select id as surface_id
      from cohort
      where method in ('POST', 'PUT', 'PATCH', 'DELETE')
    )
    select
      (select count(*) from cohort) as totalSurfaces,
      (select count(*) from provider_edges) as withProviders,
      (select count(*) from any_consumers) as withAnyConsumers,
      (select count(*) from proven_consumers) as withProvenConsumers,
      (select count(*) from validators) as withValidators,
      (select count(*) from exact_validators) as withExactValidators,
      (select count(*) from responses) as withResponseContracts,
      (select count(*) from exact_responses) as withExactResponseContracts,
      (
        select count(*)
        from cohort c
        where exists (select 1 from provider_edges p where p.surface_id = c.id)
          and exists (select 1 from responses r where r.surface_id = c.id)
      ) as provenProviderAndResponse,
      (
        select count(*)
        from cohort c
        where exists (select 1 from provider_edges p where p.surface_id = c.id)
          and exists (select 1 from validators v where v.surface_id = c.id)
          and exists (select 1 from responses r where r.surface_id = c.id)
      ) as provenProviderRequestAndResponse,
      (
        select count(*)
        from cohort c
        where exists (select 1 from proven_consumers pc where pc.surface_id = c.id)
          and exists (select 1 from provider_edges p where p.surface_id = c.id)
      ) as provenConsumerAndProvider,
      (
        select count(*)
        from cohort c
        where exists (select 1 from proven_consumers pc where pc.surface_id = c.id)
          and exists (select 1 from provider_edges p where p.surface_id = c.id)
          and exists (select 1 from responses r where r.surface_id = c.id)
      ) as provenConsumerProviderResponse,
      (
        select count(*)
        from cohort c
        where exists (select 1 from proven_consumers pc where pc.surface_id = c.id)
          and exists (select 1 from provider_edges p where p.surface_id = c.id)
          and exists (select 1 from validators v where v.surface_id = c.id)
          and exists (select 1 from responses r where r.surface_id = c.id)
      ) as fullyStructured,
      (
        select count(*)
        from read_like rl
        where exists (select 1 from responses r where r.surface_id = rl.surface_id)
      ) as readLikeWithResponse,
      (
        select count(*)
        from mutating m
        where exists (select 1 from validators v where v.surface_id = m.surface_id)
      ) as mutatingWithValidator,
      (
        select count(*)
        from mutating m
        where exists (select 1 from validators v where v.surface_id = m.surface_id)
          and exists (select 1 from responses r where r.surface_id = m.surface_id)
      ) as mutatingWithRequestAndResponse,
      (select count(*) from read_like) as readLikeTotal,
      (select count(*) from mutating) as mutatingTotal
  `;

  return db.prepare(sql).get();
}

function topProviderQuality(limit = 10) {
  const sql = `
    with provider_surfaces as (
      select id, file_path
      from structural_nodes
      where node_type = 'capability-surface'
        and file_path like '%Provider.php'
    ),
    provider_edges as (
      select distinct ps.id as surface_id, ps.file_path, e.target_node_id as provider_id
      from provider_surfaces ps
      join structural_edges e
        on e.source_node_id = ps.id
       and e.edge_type = 'handled_by'
    ),
    proven_consumers as (
      select distinct e.target_node_id as surface_id
      from structural_edges e
      where e.edge_type = 'calls_surface'
        and e.confidence >= 0.75
    ),
    validators as (
      select distinct pe.surface_id
      from provider_edges pe
      join structural_edges e
        on e.source_node_id = pe.provider_id
       and e.edge_type = 'validates_with'
    ),
    responses as (
      select distinct pe.surface_id
      from provider_edges pe
      join structural_edges e
        on e.source_node_id = pe.provider_id
       and e.edge_type = 'returns_contract'
    )
    select
      ps.file_path,
      count(*) as surfaces,
      count(distinct case when pe.provider_id is not null then ps.id end) as withProviders,
      count(distinct case when v.surface_id is not null then ps.id end) as withValidators,
      count(distinct case when r.surface_id is not null then ps.id end) as withResponses,
      count(distinct case when pc.surface_id is not null then ps.id end) as withProvenConsumers,
      count(distinct case when pe.provider_id is not null and r.surface_id is not null then ps.id end) as providerResponseClosed,
      count(distinct case when pe.provider_id is not null and v.surface_id is not null and r.surface_id is not null then ps.id end) as providerRequestResponseClosed,
      count(distinct case when pe.provider_id is not null and v.surface_id is not null and r.surface_id is not null and pc.surface_id is not null then ps.id end) as fullyStructured
    from provider_surfaces ps
    left join provider_edges pe on pe.surface_id = ps.id
    left join validators v on v.surface_id = ps.id
    left join responses r on r.surface_id = ps.id
    left join proven_consumers pc on pc.surface_id = ps.id
    group by ps.file_path
    order by surfaces desc, ps.file_path asc
    limit ${Number(limit)}
  `;

  return db.prepare(sql).all();
}

const result = {
  allSurfaces: cohortMetrics(),
  providerDeclared: cohortMetrics(`file_path like ${quote('%Provider.php')}`),
  externalApiProvider: cohortMetrics(`file_path = ${quote('src/Module/ExternalApi/RouteServiceProvider.php')}`),
  topProviderQuality: topProviderQuality(10),
};

console.log(JSON.stringify(result, null, 2));
db.close();
