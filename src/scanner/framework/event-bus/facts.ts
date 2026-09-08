import { resolveProjectBinding } from '../../project-resolution/resolver.js';
import {
  exportedNames,
  firstArgument,
  imports,
  literal,
  sortDiagnostics,
  sourceFiles,
  sourceLocation,
  uniqueSorted,
} from './shared.js';
import type {
  EventBusCallFactV1,
  EventBusCatalogEntryV1,
  EventBusFactResultV1,
  EventBusInputV1,
} from './types.js';

interface Receiver {
  bus: EventBusCatalogEntryV1;
  operation: 'publish' | 'subscribe';
}

/** Extract calls only after receiver identity and the exact method have matched the catalog. */
export async function extractEventBusFacts(input: EventBusInputV1): Promise<EventBusFactResultV1> {
  const sources = await sourceFiles(input);
  const calls: EventBusCallFactV1[] = [];
  const diagnostics: EventBusFactResultV1['diagnostics'] = [];

  for (const [filePath, source] of sources) {
    const fileImports = imports(source);
    const aliases = localAliases(source);
    for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/gu)) {
      const receiverName = aliases.get(match[1]) ?? match[1];
      const resolved = resolveReceiver(filePath, receiverName, match[2], fileImports, input);
      if (!resolved) continue; // Unknown/RxJS/DOM receivers are intentionally inert.
      const open = match.index + match[0].lastIndexOf('(');
      const eventKey = literal(firstArgument(source, open));
      const location = sourceLocation(filePath, source, match.index);
      if (!eventKey) {
        diagnostics.push({
          code: 'EVENT_BUS_DYNAMIC_KEY',
          message: `${match[1]}.${match[2]} does not supply a static literal event key.`,
          location,
        });
        continue;
      }
      if (resolved.bus.eventKeys.length > 0 && !resolved.bus.eventKeys.includes(eventKey)) {
        diagnostics.push({
          code: 'EVENT_BUS_UNKNOWN_KEY',
          message: `${eventKey} is not declared by bus ${resolved.bus.busId}.`,
          location,
        });
        continue;
      }
      const ownerExport = ownerAt(filePath, source, match.index, input);
      if (!ownerExport) {
        diagnostics.push({
          code: 'EVENT_BUS_UNRESOLVED_OWNER',
          message: `Exact bus call ${match[1]}.${match[2]} has no owning first-party declaration.`,
          location,
        });
        continue;
      }
      const imported = fileImports.get(receiverName);
      calls.push({
        kind: 'event-bus-call',
        filePath,
        ownerExport,
        ...(imported
          ? {
              busBinding: {
                localName: imported.localName,
                importedName: imported.importedName,
                sourceSpecifier: imported.sourceSpecifier,
                targetFile: resolved.bus.declarationFile,
                targetExport: resolved.bus.exportName,
              },
            }
          : {}),
        busId: resolved.bus.busId,
        method: match[2],
        operation: resolved.operation,
        eventKey,
        location,
      });
    }
  }

  calls.sort((a, b) =>
    [a.filePath, a.location.line, a.location.column, a.busId, a.method, a.eventKey]
      .join('\0')
      .localeCompare(
        [b.filePath, b.location.line, b.location.column, b.busId, b.method, b.eventKey].join('\0')
      )
  );
  return {
    calls,
    dependencies: uniqueSorted([...input.project.fingerprintInputs, ...sources.keys()]),
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function resolveReceiver(
  filePath: string,
  receiver: string,
  method: string,
  fileImports: ReturnType<typeof imports>,
  input: EventBusInputV1
): Receiver | undefined {
  const byId = new Map(input.catalog.map((item) => [item.busId, item]));
  const local = input.catalog.filter(
    (item) => item.declarationFile === filePath && item.exportName === receiver
  );
  let bus = local.length === 1 ? local[0] : undefined;
  const imported = fileImports.get(receiver);
  if (!bus && imported) {
    const resolution = resolveProjectBinding(
      {
        importerFile: filePath,
        specifier: imported.sourceSpecifier,
        importedName: imported.importedName,
        mode: 'import',
      },
      input.project
    );
    if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved')
      return undefined;
    const target = resolution.exported.target;
    bus =
      byId.get(`${target.filePath}#${imported.importedName}`) ??
      input.catalog.find(
        (entry) =>
          entry.declarationFile === target.filePath && entry.exportName === imported.importedName
      );
  }
  if (!bus) return undefined;
  if (bus.methods.publish.includes(method)) return { bus, operation: 'publish' };
  if (bus.methods.subscribe.includes(method)) return { bus, operation: 'subscribe' };
  return undefined;
}

/** Track only exact identifier aliases, including `useContext(EventContext)` and simple assignments. */
function localAliases(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/gu
  )) {
    result.set(match[1], match[2]);
  }
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useContext\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/gu
  )) {
    result.set(match[1], match[2]);
  }
  return result;
}

function ownerAt(
  filePath: string,
  source: string,
  offset: number,
  input: EventBusInputV1
): string | undefined {
  const extraction = input.extractions?.get(filePath);
  if (extraction) {
    const byteOffset = Buffer.byteLength(source.slice(0, offset));
    const node = extraction.nodes
      .filter(
        (item) =>
          (item.type === 'function' || item.type === 'class' || item.type === 'method') &&
          item.range.startByte <= byteOffset &&
          byteOffset <= item.range.endByte
      )
      .sort(
        (a, b) => a.range.endByte - a.range.startByte - (b.range.endByte - b.range.startByte)
      )[0];
    if (node) {
      const name = node.container ?? node.name;
      return exportedNames(source).get(name) ?? name;
    }
  }
  let owner: { name: string; start: number; end: number } | undefined;
  const exports = exportedNames(source);
  for (const match of source.matchAll(
    /\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\x7b/gu
  )) {
    const end = matchingBrace(source, match.index + match[0].lastIndexOf('{'));
    if (
      match.index <= offset &&
      offset <= end &&
      (!owner || end - match.index < owner.end - owner.start)
    )
      owner = { name: exports.get(match[1]) ?? match[1], start: match.index, end };
  }
  for (const match of source.matchAll(
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\x7b/gu
  )) {
    const end = matchingBrace(source, match.index + match[0].lastIndexOf('{'));
    if (
      match.index <= offset &&
      offset <= end &&
      (!owner || end - match.index < owner.end - owner.start)
    )
      owner = { name: exports.get(match[1]) ?? match[1], start: match.index, end };
  }
  for (const match of source.matchAll(
    /\b(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)[^\x7b]*\x7b/gu
  )) {
    const end = matchingBrace(source, match.index + match[0].lastIndexOf('{'));
    if (
      match.index <= offset &&
      offset <= end &&
      (!owner || end - match.index < owner.end - owner.start)
    )
      owner = { name: exports.get(match[1]) ?? match[1], start: match.index, end };
  }
  return owner?.name;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0,
    quote = '',
    escaped = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
