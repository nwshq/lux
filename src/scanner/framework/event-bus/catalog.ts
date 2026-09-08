import { resolveProjectBinding } from '../../project-resolution/resolver.js';
import {
  exportedNames,
  imports,
  PUBLISH_METHODS,
  sourceFiles,
  sourceLocation,
  SUBSCRIBE_METHODS,
  uniqueSorted,
} from './shared.js';
import type { EventBusCatalogEntryV1, EventBusCatalogResultV1, EventBusInputV1 } from './types.js';

interface Candidate {
  localName: string;
  exportName: string;
  declarationOffset: number;
  typeNames: string[];
  methods: { publish: Set<string>; subscribe: Set<string> };
  delegated?: { receiver: string; method: string };
}

/** Discover only declarations carrying concrete, evidence-backed publish and subscribe methods. */
export async function buildEventBusCatalog(
  input: EventBusInputV1
): Promise<EventBusCatalogResultV1> {
  const sources = await sourceFiles(input);
  const catalog = new Map<string, EventBusCatalogEntryV1>();
  for (const entry of input.catalog) catalog.set(entry.busId, normalizeEntry(entry));

  const candidates = new Map<string, Candidate[]>();
  const eventKeysByFile = new Map<string, string[]>();
  for (const [filePath, source] of sources) {
    eventKeysByFile.set(filePath, extractEventKeys(source));
    candidates.set(filePath, discoverCandidates(source));
  }

  // Direct singleton/object/class/context declarations. A bus must expose both sides.
  for (const [filePath, values] of candidates) {
    const source = sources.get(filePath)!;
    const keys = eventKeysByFile.get(filePath) ?? [];
    for (const candidate of values) {
      if (candidate.methods.publish.size === 0 || candidate.methods.subscribe.size === 0) continue;
      addCatalog(catalog, {
        busId: declarationBusId(filePath, candidate.exportName),
        declarationFile: filePath,
        exportName: candidate.exportName,
        eventKeys: keys,
        methods: {
          publish: uniqueSorted(candidate.methods.publish),
          subscribe: uniqueSorted(candidate.methods.subscribe),
        },
        evidence: [sourceLocation(filePath, source, candidate.declarationOffset)],
      });
    }
  }

  // An exact adapter is itself an alias of the bus it delegates to; it never creates a second bus.
  for (const [filePath, values] of candidates) {
    const source = sources.get(filePath)!;
    const fileImports = imports(source);
    for (const candidate of values.filter((item) => item.delegated)) {
      const target = resolveReceiver(
        filePath,
        candidate.delegated!.receiver,
        fileImports,
        candidates,
        catalog,
        input
      );
      if (!target) continue;
      const operation = operationFor(candidate.delegated!.method, target);
      if (!operation) continue;
      const alias =
        operation === 'publish' ? candidate.methods.publish : candidate.methods.subscribe;
      if (alias.size === 0) continue;
      addCatalog(catalog, {
        ...target,
        methods: {
          publish:
            operation === 'publish'
              ? uniqueSorted([...target.methods.publish, ...alias])
              : target.methods.publish,
          subscribe:
            operation === 'subscribe'
              ? uniqueSorted([...target.methods.subscribe, ...alias])
              : target.methods.subscribe,
        },
        evidence: [
          ...target.evidence,
          sourceLocation(filePath, source, candidate.declarationOffset),
        ],
      });
    }
  }

  return {
    catalog: [...catalog.values()].sort((a, b) => a.busId.localeCompare(b.busId)),
    dependencies: uniqueSorted([...input.project.fingerprintInputs, ...sources.keys()]),
    diagnostics: [],
  };
}

function discoverCandidates(source: string): Candidate[] {
  const exports = exportedNames(source);
  const result: Candidate[] = [];
  const interfaceMethods = typeMethods(source);

  // Exported class declarations and exported singleton instances.
  for (const match of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^\x7b]*\x7b/gu)) {
    const close = matchingBrace(source, match.index + match[0].lastIndexOf('{'));
    if (close < 0) continue;
    const localName = match[1];
    const exportName = exports.get(localName);
    if (!exportName) continue;
    result.push({
      localName,
      exportName,
      declarationOffset: match.index,
      typeNames: implementedTypes(match[0]),
      methods: methodsFromBody(source.slice(match.index, close + 1), interfaceMethods),
    });
  }
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+))?=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/gu
  )) {
    const exportName = exports.get(match[1]);
    if (!exportName) continue;
    const klass = result.find((item) => item.localName === match[3]);
    const typed = methodsForTypes([match[2] ?? '', match[3]], interfaceMethods);
    result.push({
      localName: match[1],
      exportName,
      declarationOffset: match.index,
      typeNames: [match[2] ?? '', match[3]].filter(Boolean),
      methods: mergeMethods(klass?.methods, typed),
    });
  }
  // Exported object literals whose exact members prove both operations.
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=;]+))?=\s*\x7b/gu
  )) {
    const exportName = exports.get(match[1]);
    if (!exportName) continue;
    const open = match.index + match[0].lastIndexOf('{');
    const close = matchingBrace(source, open);
    if (close < 0) continue;
    result.push({
      localName: match[1],
      exportName,
      declarationOffset: match.index,
      typeNames: match[2] ? [match[2]] : [],
      methods: mergeMethods(
        methodsFromBody(source.slice(open, close + 1), interfaceMethods),
        methodsForTypes(match[2] ? [match[2]] : [], interfaceMethods)
      ),
    });
  }
  // Typed contexts expose a bus identity only when a provider supplies one exact resolved emitter.
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createContext\s*<\s*([^>]+)>\s*\(/gu
  )) {
    const exportName = exports.get(match[1]);
    if (!exportName) continue;
    const provided = providerValue(source, match[1]);
    if (!provided) continue;
    result.push({
      localName: match[1],
      exportName,
      declarationOffset: match.index,
      typeNames: [match[2]],
      methods: methodsForTypes([match[2]], interfaceMethods),
      delegated: { receiver: provided, method: 'context' },
    });
  }
  // Exported method/function wrappers are admitted only when they exactly delegate one operation.
  for (const match of source.matchAll(
    /\b(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\x7b/gu
  )) {
    const exportName = exports.get(match[1]);
    if (!exportName) continue;
    const close = matchingBrace(source, match.index + match[0].lastIndexOf('{'));
    if (close < 0) continue;
    const body = source.slice(match.index, close + 1);
    const delegated = /\b([A-Za-z_$][\w$]*)\.(emit|emitAppEvent|on|once)\s*\(/u.exec(body);
    if (!delegated) continue;
    const operation = PUBLISH_METHODS.has(delegated[2]) ? 'publish' : 'subscribe';
    result.push({
      localName: match[1],
      exportName,
      declarationOffset: match.index,
      typeNames: [],
      methods: {
        publish: new Set(operation === 'publish' ? [exportName] : []),
        subscribe: new Set(operation === 'subscribe' ? [exportName] : []),
      },
      delegated: { receiver: delegated[1], method: delegated[2] },
    });
  }
  return result;
}

function typeMethods(
  source: string
): Map<string, { publish: Set<string>; subscribe: Set<string> }> {
  const result = new Map<string, { publish: Set<string>; subscribe: Set<string> }>();
  for (const match of source.matchAll(
    /\b(?:interface|type)\s+([A-Za-z_$][\w$]*)[^=\x7b]*[=]?\s*\x7b/gu
  )) {
    const open = match.index + match[0].lastIndexOf('{');
    const close = matchingBrace(source, open);
    if (close < 0) continue;
    result.set(match[1], methodsFromBody(source.slice(open, close + 1), result));
  }
  return result;
}

function methodsFromBody(
  body: string,
  _types: ReadonlyMap<string, unknown>
): { publish: Set<string>; subscribe: Set<string> } {
  const publish = new Set<string>();
  const subscribe = new Set<string>();
  for (const match of body.matchAll(
    /(?:^|[;,{\n]\s*)([A-Za-z_$][\w$]*)\s*(?:<[^>{};]*>)?\s*\([^)]*\)\s*(?::|\x7b|=>|;|,)/gmu
  )) {
    if (PUBLISH_METHODS.has(match[1])) publish.add(match[1]);
    if (SUBSCRIBE_METHODS.has(match[1])) subscribe.add(match[1]);
  }
  return { publish, subscribe };
}

function methodsForTypes(
  names: string[],
  map: ReadonlyMap<string, { publish: Set<string>; subscribe: Set<string> }>
) {
  let methods: { publish: Set<string>; subscribe: Set<string> } | undefined;
  for (const value of names) {
    for (const name of value.match(/[A-Za-z_$][\w$]*/gu) ?? [])
      methods = mergeMethods(methods, map.get(name));
  }
  return methods ?? { publish: new Set<string>(), subscribe: new Set<string>() };
}

function mergeMethods(
  ...values: Array<{ publish: Set<string>; subscribe: Set<string> } | undefined>
) {
  return {
    publish: new Set(values.flatMap((item) => [...(item?.publish ?? [])])),
    subscribe: new Set(values.flatMap((item) => [...(item?.subscribe ?? [])])),
  };
}

function extractEventKeys(source: string): string[] {
  const result = new Set<string>();
  for (const declaration of source.matchAll(
    /\b(?:interface|type)\s+([A-Za-z_$][\w$]*(?:Events|EventMap))\b[^=\x7b]*[=]?\s*\x7b/gu
  )) {
    const open = declaration.index + declaration[0].lastIndexOf('{');
    const close = matchingBrace(source, open);
    if (close < 0) continue;
    const body = source.slice(open + 1, close);
    for (const key of body.matchAll(/(?:^|[;,\n]\s*)(?:readonly\s+)?(['"])([^'"]+)\1\s*[?:]/gmu))
      result.add(key[2]);
  }
  return [...result].sort();
}

function resolveReceiver(
  filePath: string,
  receiver: string,
  fileImports: ReturnType<typeof imports>,
  candidates: ReadonlyMap<string, Candidate[]>,
  catalog: ReadonlyMap<string, EventBusCatalogEntryV1>,
  input: EventBusInputV1
): EventBusCatalogEntryV1 | undefined {
  const local = candidates.get(filePath)?.find((item) => item.localName === receiver);
  if (local) return catalog.get(declarationBusId(filePath, local.exportName));
  const binding = fileImports.get(receiver);
  if (!binding) return undefined;
  const resolution = resolveProjectBinding(
    {
      importerFile: filePath,
      specifier: binding.sourceSpecifier,
      importedName: binding.importedName,
      mode: 'import',
    },
    input.project
  );
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved')
    return undefined;
  const target = resolution.exported.target;
  const exported = binding.importedName === 'default' ? 'default' : binding.importedName;
  return catalog.get(declarationBusId(target.filePath, exported));
}

function operationFor(
  method: string,
  target: EventBusCatalogEntryV1
): 'publish' | 'subscribe' | undefined {
  if (method === 'context')
    return target.methods.publish.length && target.methods.subscribe.length
      ? 'subscribe'
      : undefined;
  if (target.methods.publish.includes(method)) return 'publish';
  if (target.methods.subscribe.includes(method)) return 'subscribe';
  return undefined;
}

function providerValue(source: string, contextName: string): string | undefined {
  const pattern = new RegExp(
    `<${contextName}\\.Provider\\b[^>]*\\bvalue\\s*=\\s*\\x7b\\s*([A-Za-z_$][\\w$]*)\\s*\\}`,
    'u'
  );
  return pattern.exec(source)?.[1];
}

function implementedTypes(header: string): string[] {
  return (
    /\bimplements\s+([^\x7b]+)/u
      .exec(header)?.[1]
      .split(',')
      .map((x) => x.trim()) ?? []
  );
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
function declarationBusId(filePath: string, exportName: string): string {
  return `${filePath}#${exportName}`;
}
function normalizeEntry(entry: EventBusCatalogEntryV1): EventBusCatalogEntryV1 {
  return {
    ...entry,
    eventKeys: uniqueSorted(entry.eventKeys),
    methods: {
      publish: uniqueSorted(entry.methods.publish),
      subscribe: uniqueSorted(entry.methods.subscribe),
    },
    evidence: [...entry.evidence],
  };
}
function addCatalog(
  catalog: Map<string, EventBusCatalogEntryV1>,
  entry: EventBusCatalogEntryV1
): void {
  const prior = catalog.get(entry.busId);
  catalog.set(
    entry.busId,
    prior
      ? {
          ...prior,
          eventKeys: uniqueSorted([...prior.eventKeys, ...entry.eventKeys]),
          methods: {
            publish: uniqueSorted([...prior.methods.publish, ...entry.methods.publish]),
            subscribe: uniqueSorted([...prior.methods.subscribe, ...entry.methods.subscribe]),
          },
          evidence: [...prior.evidence, ...entry.evidence],
        }
      : normalizeEntry(entry)
  );
}
