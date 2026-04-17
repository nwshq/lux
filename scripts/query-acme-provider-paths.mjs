import Database from 'better-sqlite3';
const db = new Database('/tmp/lux-auctic-module-routes.db', { readonly: true });
const rows = db.prepare(`
  select file_path, symbol_name,
         json_extract(metadata, '$.path') as path,
         json_extract(metadata, '$.localFragment') as local_fragment,
         json_extract(metadata, '$.declarationLineage') as declaration_lineage,
         json_extract(metadata, '$.explicitProvider') as provider,
         json_extract(metadata, '$.routeName') as route_name
  from structural_nodes
  where node_type = 'capability-surface'
    and file_path = 'src/Module/ExternalApi/RouteServiceProvider.php'
  order by path asc, symbol_name asc
`).all();
console.log(JSON.stringify(rows, null, 2));
db.close();
