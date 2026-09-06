import type { Extraction } from '../ast/extract.js';
import type { ExportTargetV1, ModuleExportIndexV1 } from '../contracts/program.js';

interface ModuleSyntaxFactV1 {
  kind:
    | 'esm-import'
    | 'esm-export-default'
    | 'esm-export-named'
    | 'esm-reexport-named'
    | 'esm-reexport-all'
    | 'commonjs-require'
    | 'commonjs-module-exports'
    | 'commonjs-exports-member';
  localName?: string;
  importedName?: string;
  exportedName?: string;
  specifier?: string;
}

export interface FileExtractionV1 {
  filePath: string;
  extraction: Omit<Extraction, 'moduleFacts'> & { moduleFacts?: readonly ModuleSyntaxFactV1[] };
}

export type ExportResolutionV1 =
  | { status: 'resolved'; target: ExportTargetV1 }
  | { status: 'missing' | 'cycle' }
  | { status: 'ambiguous'; candidates: ExportTargetV1[] };

function targetKey(target: ExportTargetV1): string {
  return `${target.filePath}\0${target.declarationId ?? target.localName}`;
}

function targetSortKey(target: ExportTargetV1): string {
  return `${target.filePath}\0${target.localName}\0${target.declarationId ?? ''}`;
}

function compareTargets(left: ExportTargetV1, right: ExportTargetV1): number {
  const leftKey = targetSortKey(left);
  const rightKey = targetSortKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function preferredTarget(left: ExportTargetV1, right: ExportTargetV1): ExportTargetV1 {
  if (left.declarationId === undefined && right.declarationId !== undefined) return right;
  if (right.declarationId === undefined && left.declarationId !== undefined) return left;
  return compareTargets(left, right) <= 0 ? left : right;
}

function uniqueTargets(targets: readonly ExportTargetV1[]): ExportTargetV1[] {
  const byKey = new Map<string, ExportTargetV1>();
  for (const target of targets) {
    const key = targetKey(target);
    const existing = byKey.get(key);
    byKey.set(key, existing ? preferredTarget(existing, target) : target);
  }
  return [...byKey.values()].sort(compareTargets);
}

function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function directTarget(
  index: ModuleExportIndexV1,
  exportedName: string
): ExportTargetV1 | undefined {
  return exportedName === 'default' ? index.default : ownValue(index.named, exportedName);
}

function removeDirectTarget(index: ModuleExportIndexV1, exportedName: string): void {
  if (exportedName === 'default') delete index.default;
  else delete index.named[exportedName];
}

function setDirectTarget(
  index: ModuleExportIndexV1,
  exportedName: string,
  target: ExportTargetV1
): void {
  if (exportedName === 'default') index.default = target;
  else setOwnValue(index.named, exportedName, target);
}

function addDirectTarget(
  index: ModuleExportIndexV1,
  exportedName: string,
  target: ExportTargetV1
): void {
  const conflict = ownValue(index.conflicts, exportedName);
  if (conflict) {
    const candidates = uniqueTargets([...conflict, target]);
    if (candidates.length > conflict.length)
      setOwnValue(index.conflicts!, exportedName, candidates);
    return;
  }

  const existing = directTarget(index, exportedName);
  if (!existing) {
    setDirectTarget(index, exportedName, target);
    return;
  }

  const candidates = uniqueTargets([existing, target]);
  if (candidates.length === 1) return;

  removeDirectTarget(index, exportedName);
  index.conflicts ??= {};
  setOwnValue(index.conflicts, exportedName, candidates);
}

function exportTarget(
  file: FileExtractionV1,
  localName: string,
  declarations: ReadonlySet<string>
): ExportTargetV1 {
  return {
    localName,
    filePath: file.filePath,
    ...(declarations.has(localName) ? { declarationId: localName } : {}),
  };
}

export function buildModuleExportIndexes(
  files: readonly FileExtractionV1[]
): ReadonlyMap<string, ModuleExportIndexV1> {
  const result = new Map<string, ModuleExportIndexV1>();

  for (const file of files) {
    const index: ModuleExportIndexV1 = { named: {}, reexports: [] };
    const declarations = new Set(
      file.extraction.nodes.map((node) =>
        node.type === 'method' && node.container ? `${node.container}.${node.name}` : node.name
      )
    );

    for (const fact of file.extraction.moduleFacts ?? []) {
      if (fact.kind === 'esm-export-default' || fact.kind === 'commonjs-module-exports') {
        const localName = fact.localName ?? 'default';
        addDirectTarget(index, 'default', exportTarget(file, localName, declarations));
      } else if (fact.kind === 'esm-export-named' || fact.kind === 'commonjs-exports-member') {
        const exportedName = fact.exportedName ?? fact.localName;
        if (exportedName) {
          const localName = fact.localName ?? exportedName;
          addDirectTarget(index, exportedName, exportTarget(file, localName, declarations));
        }
      } else if (
        (fact.kind === 'esm-reexport-named' || fact.kind === 'esm-reexport-all') &&
        fact.specifier
      ) {
        index.reexports.push({
          exported: fact.exportedName ?? '*',
          imported: fact.importedName ?? '*',
          specifier: fact.specifier,
        });
      }
    }

    result.set(file.filePath, index);
  }

  return result;
}

export function resolveExport(
  filePath: string,
  exportedName: string,
  indexes: ReadonlyMap<string, ModuleExportIndexV1>,
  resolveModule: (fromFile: string, specifier: string) => string | undefined,
  visited: ReadonlySet<string> = new Set()
): ExportResolutionV1 {
  const visitKey = `${filePath}\0${exportedName}`;
  if (visited.has(visitKey)) return { status: 'cycle' };

  const index = indexes.get(filePath);
  if (!index) return { status: 'missing' };

  const nextVisited = new Set(visited).add(visitKey);
  const conflict = ownValue(index.conflicts, exportedName) ?? [];
  const direct = directTarget(index, exportedName);
  const targets: ExportTargetV1[] = [...conflict, ...(direct ? [direct] : [])];
  let foundCycle = false;

  for (const reexport of index.reexports) {
    if (reexport.exported !== '*' && reexport.exported !== exportedName) continue;

    const targetFile = resolveModule(filePath, reexport.specifier);
    if (!targetFile) continue;

    const importedName = reexport.exported === '*' ? exportedName : reexport.imported;
    if (reexport.exported === '*' && importedName === 'default') continue;

    const nested = resolveExport(targetFile, importedName, indexes, resolveModule, nextVisited);
    if (nested.status === 'resolved') targets.push(nested.target);
    else if (nested.status === 'ambiguous') targets.push(...nested.candidates);
    else if (nested.status === 'cycle') foundCycle = true;
  }

  const unique = uniqueTargets(targets);
  if (unique.length > 1) return { status: 'ambiguous', candidates: unique };
  if (unique.length === 1) return { status: 'resolved', target: unique[0] };
  return { status: foundCycle ? 'cycle' : 'missing' };
}
