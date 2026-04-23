import { join } from 'node:path';
import { detectModuleBoundaries, resolveModule } from '../../imports/module-boundary.js';
import type { AssociationContext, AssociationResolver, StructuralRelationEdge } from '../types.js';
import { fileNodeId } from '../types.js';
import type { ConfidenceClass, EdgeType } from '../../../db/types.js';

const PHP_NAMESPACE_RE = /^\s*namespace\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*;/m;
const PHP_DECLARATION_RE = /\b(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
const PHP_USE_RE = /^\s*use\s+([^;]+);/gm;
const CONSTRUCTOR_RE = /function\s+__construct\s*\(([\s\S]*?)\)/g;
const METHOD_RE = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\)/g;
const PARAM_TYPE_RE =
  /(?:^|,)\s*(?:public|protected|private|readonly|static|\s)*\??([A-Za-z_\\][A-Za-z0-9_\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)/g;
const BINDING_RE =
  /\$this->app->(?:bind|singleton|scoped)\(\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*,\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class/gi;
const DISPATCH_NEW_RE =
  /\b(?:dispatch|dispatch_sync|dispatch_now|Bus::dispatch|Queue::push)\s*\(\s*new\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\b/g;
const DISPATCH_STATIC_RE = /\b([A-Za-z_\\][A-Za-z0-9_\\]*)::dispatch(?:Sync|Now)?\s*\(/g;
const EVENT_NEW_RE = /\b(?:event|broadcast)\s*\(\s*new\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\b/g;
const EVENT_STATIC_RE = /\b([A-Za-z_\\][A-Za-z0-9_\\]*)::dispatch\s*\(/g;
const EVENT_LISTEN_RE =
  /Event::listen\(\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*,\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class/g;
const LISTEN_MAP_RE = /([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*=>\s*\[((?:[\s\S]*?))\]/g;
const LISTENER_CLASS_RE = /([A-Za-z_\\][A-Za-z0-9_\\]*)::class/g;
const RESOURCE_INSTANTIATION_RE =
  /\bnew\s+([A-Za-z_\\][A-Za-z0-9_\\]*(?:Resource|Collection))\b|([A-Za-z_\\][A-Za-z0-9_\\]*(?:Resource|Collection))::collection\s*\(/g;
const BUILTIN_TYPES = new Set([
  'array',
  'bool',
  'callable',
  'false',
  'float',
  'int',
  'iterable',
  'mixed',
  'null',
  'object',
  'parent',
  'resource',
  'self',
  'static',
  'string',
  'true',
  'void',
]);

interface PhpFileDescriptor {
  filePath: string;
  absolutePath: string;
  content: string;
  namespace?: string;
  imports: Map<string, string>;
  declaredFqcns: string[];
  sourceModule: string | null;
  sourceBoundaryKind: 'owned-region' | 'glue' | 'unresolved';
}

interface ResolvedPhpReference {
  className: string;
  fqcn?: string;
  filePath?: string;
  targetModule: string | null;
}

interface PhpIndex {
  descriptors: PhpFileDescriptor[];
  byFqcn: Map<string, string>;
  byShortName: Map<string, string[]>;
  fileContentByPath: Map<string, string>;
  patterns: string[];
}

interface CollectorEntry {
  edge: StructuralRelationEdge;
  keys: Set<string>;
}

class EdgeCollector {
  private readonly edges = new Map<string, CollectorEntry>();

  add(
    id: string,
    edgeType: EdgeType,
    sourcePath: string,
    targetPath: string,
    confidence: number,
    confidenceClass: ConfidenceClass,
    evidenceKind: string,
    location: { filePath: string; line?: number; note?: string },
    extractedAt: number
  ): void {
    const existing = this.edges.get(id);
    if (existing) {
      const key = `${location.filePath}:${location.line ?? ''}:${location.note ?? ''}`;
      if (!existing.keys.has(key)) {
        existing.keys.add(key);
        existing.edge.provenance.evidenceLocations.push(location);
      }
      if (confidence > existing.edge.confidence) {
        existing.edge.confidence = confidence;
        existing.edge.confidenceClass = confidenceClass;
      }
      return;
    }

    const key = `${location.filePath}:${location.line ?? ''}:${location.note ?? ''}`;
    this.edges.set(id, {
      edge: {
        id,
        edgeType,
        sourceNodeId: fileNodeId(sourcePath),
        targetNodeId: fileNodeId(targetPath),
        sourceLanguage: 'php',
        targetLanguage: 'php',
        confidence,
        confidenceClass,
        provenance: {
          resolver: 'laravel-boundary-evidence',
          evidenceKind,
          evidenceLocations: [location],
          extractedAt,
        },
      },
      keys: new Set([key]),
    });
  }

  values(): StructuralRelationEdge[] {
    return Array.from(this.edges.values(), ({ edge }) => edge);
  }
}

export class LaravelBoundaryEvidenceResolver implements AssociationResolver {
  readonly name = 'laravel-boundary-evidence';

  supports(context: AssociationContext): boolean {
    if (!context.entries.some((entry) => entry.languageId === 'php')) return false;
    return detectPatterns(context).length > 0;
  }

  resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    const patterns = detectPatterns(context);
    if (patterns.length === 0) return Promise.resolve([]);

    const index = buildPhpIndex(context, patterns);
    const now = Math.floor(Date.now() / 1000);
    const collector = new EdgeCollector();

    for (const descriptor of index.descriptors) {
      collectServiceEvidence(descriptor, index, collector, now);
      collectAsyncEvidence(descriptor, index, collector, now);
      collectContractEvidence(descriptor, index, collector, now);
      collectPipelineEvidence(descriptor, index, collector, now);
    }

    return Promise.resolve(collector.values());
  }
}

function collectServiceEvidence(
  descriptor: PhpFileDescriptor,
  index: PhpIndex,
  collector: EdgeCollector,
  extractedAt: number
): void {
  let match: RegExpExecArray | null;

  CONSTRUCTOR_RE.lastIndex = 0;
  while ((match = CONSTRUCTOR_RE.exec(descriptor.content)) !== null) {
    const params = match[1];
    PARAM_TYPE_RE.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = PARAM_TYPE_RE.exec(params)) !== null) {
      const resolved = resolvePhpReference(paramMatch[1], descriptor, index);
      if (!isCrossModuleReference(descriptor, resolved)) continue;

      collector.add(
        `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:resolves_service`,
        'resolves_service',
        descriptor.filePath,
        resolved.filePath,
        0.96,
        'artifact-backed',
        'constructor-service-resolution',
        {
          filePath: descriptor.filePath,
          line: lineOf(descriptor.content, match.index),
          note: `${resolved.className} $${paramMatch[2]}`,
        },
        extractedAt
      );
    }
  }

  BINDING_RE.lastIndex = 0;
  while ((match = BINDING_RE.exec(descriptor.content)) !== null) {
    const contractRef = resolvePhpReference(match[1], descriptor, index);
    const implRef = resolvePhpReference(match[2], descriptor, index);

    if (isCrossModuleReference(descriptor, implRef)) {
      collector.add(
        `${fileNodeId(descriptor.filePath)}→${fileNodeId(implRef.filePath)}:binds_service`,
        'binds_service',
        descriptor.filePath,
        implRef.filePath,
        0.92,
        'framework-inferred',
        'container-binding',
        {
          filePath: descriptor.filePath,
          line: lineOf(descriptor.content, match.index),
          note: `${match[1]} => ${match[2]}`,
        },
        extractedAt
      );
    }

    if (
      contractRef.filePath &&
      implRef.filePath &&
      contractRef.targetModule !== implRef.targetModule
    ) {
      collector.add(
        `${fileNodeId(implRef.filePath)}→${fileNodeId(contractRef.filePath)}:provides_capability`,
        'provides_capability',
        implRef.filePath,
        contractRef.filePath,
        0.86,
        'framework-inferred',
        'container-capability-owner',
        {
          filePath: descriptor.filePath,
          line: lineOf(descriptor.content, match.index),
          note: `${match[2]} provides ${match[1]}`,
        },
        extractedAt
      );
    }
  }
}

function collectAsyncEvidence(
  descriptor: PhpFileDescriptor,
  index: PhpIndex,
  collector: EdgeCollector,
  extractedAt: number
): void {
  collectDispatchEvidence(
    descriptor,
    index,
    collector,
    extractedAt,
    DISPATCH_NEW_RE,
    'job-dispatch',
    1
  );
  collectDispatchEvidence(
    descriptor,
    index,
    collector,
    extractedAt,
    DISPATCH_STATIC_RE,
    'job-dispatch-static',
    1
  );
  collectDispatchEvidence(
    descriptor,
    index,
    collector,
    extractedAt,
    EVENT_NEW_RE,
    'event-emit',
    0.95
  );
  collectDispatchEvidence(
    descriptor,
    index,
    collector,
    extractedAt,
    EVENT_STATIC_RE,
    'event-emit-static',
    0.92
  );

  EVENT_LISTEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EVENT_LISTEN_RE.exec(descriptor.content)) !== null) {
    const eventRef = resolvePhpReference(match[1], descriptor, index);
    const listenerRef = resolvePhpReference(match[2], descriptor, index);
    if (
      !eventRef.filePath ||
      !listenerRef.filePath ||
      eventRef.targetModule === listenerRef.targetModule
    ) {
      continue;
    }

    collector.add(
      `${fileNodeId(listenerRef.filePath)}→${fileNodeId(eventRef.filePath)}:listens_event`,
      'listens_event',
      listenerRef.filePath,
      eventRef.filePath,
      0.9,
      'artifact-backed',
      'event-listener-registration',
      {
        filePath: descriptor.filePath,
        line: lineOf(descriptor.content, match.index),
        note: `${match[2]} listens for ${match[1]}`,
      },
      extractedAt
    );
  }

  LISTEN_MAP_RE.lastIndex = 0;
  while ((match = LISTEN_MAP_RE.exec(descriptor.content)) !== null) {
    const eventRef = resolvePhpReference(match[1], descriptor, index);
    if (!eventRef.filePath) continue;

    LISTENER_CLASS_RE.lastIndex = 0;
    let listenerMatch: RegExpExecArray | null;
    while ((listenerMatch = LISTENER_CLASS_RE.exec(match[2])) !== null) {
      const listenerRef = resolvePhpReference(listenerMatch[1], descriptor, index);
      if (!listenerRef.filePath || listenerRef.targetModule === eventRef.targetModule) continue;

      collector.add(
        `${fileNodeId(listenerRef.filePath)}→${fileNodeId(eventRef.filePath)}:listens_event`,
        'listens_event',
        listenerRef.filePath,
        eventRef.filePath,
        0.88,
        'artifact-backed',
        'event-listen-map',
        {
          filePath: descriptor.filePath,
          line: lineOf(descriptor.content, match.index),
          note: `${listenerMatch[1]} listens for ${match[1]}`,
        },
        extractedAt
      );
    }
  }

  METHOD_RE.lastIndex = 0;
  while ((match = METHOD_RE.exec(descriptor.content)) !== null) {
    const methodName = match[1];
    if (methodName !== 'handle' && methodName !== '__invoke') continue;

    PARAM_TYPE_RE.lastIndex = 0;
    const params = match[2];
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = PARAM_TYPE_RE.exec(params)) !== null) {
      const resolved = resolvePhpReference(paramMatch[1], descriptor, index);
      if (!isCrossModuleReference(descriptor, resolved)) continue;

      const edgeType = isJobLike(resolved, index)
        ? 'handles_job'
        : isEventLike(resolved, index)
          ? 'listens_event'
          : null;
      if (!edgeType) continue;

      collector.add(
        `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:${edgeType}`,
        edgeType,
        descriptor.filePath,
        resolved.filePath,
        0.84,
        'artifact-backed',
        'handler-signature',
        {
          filePath: descriptor.filePath,
          line: lineOf(descriptor.content, match.index),
          note: `${methodName}(${resolved.className} $${paramMatch[2]})`,
        },
        extractedAt
      );
    }
  }
}

function collectContractEvidence(
  descriptor: PhpFileDescriptor,
  index: PhpIndex,
  collector: EdgeCollector,
  extractedAt: number
): void {
  for (const [alias, fqcn] of descriptor.imports) {
    const resolved = resolvePhpReference(alias, descriptor, index);
    if (!isCrossModuleReference(descriptor, resolved)) continue;

    if (isContractLike(resolved) || isSchemaLike(resolved)) {
      collector.add(
        `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:uses_contract_family`,
        'uses_contract_family',
        descriptor.filePath,
        resolved.filePath,
        0.7,
        'artifact-backed',
        'cross-module-contract-import',
        {
          filePath: descriptor.filePath,
          line: lineOfUse(descriptor.content, fqcn),
          note: fqcn,
        },
        extractedAt
      );

      if (isSchemaLike(resolved)) {
        collector.add(
          `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:shares_schema_family`,
          'shares_schema_family',
          descriptor.filePath,
          resolved.filePath,
          0.3,
          'artifact-backed',
          'cross-module-schema-import',
          {
            filePath: descriptor.filePath,
            line: lineOfUse(descriptor.content, fqcn),
            note: fqcn,
          },
          extractedAt
        );
      } else {
        collector.add(
          `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:shares_contract_family`,
          'shares_contract_family',
          descriptor.filePath,
          resolved.filePath,
          0.3,
          'artifact-backed',
          'cross-module-contract-family',
          {
            filePath: descriptor.filePath,
            line: lineOfUse(descriptor.content, fqcn),
            note: fqcn,
          },
          extractedAt
        );
      }
    }
  }

  METHOD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = METHOD_RE.exec(descriptor.content)) !== null) {
    PARAM_TYPE_RE.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = PARAM_TYPE_RE.exec(match[2])) !== null) {
      const resolved = resolvePhpReference(paramMatch[1], descriptor, index);
      if (!isCrossModuleReference(descriptor, resolved) || !isRequestLike(resolved)) continue;

      collector.add(
        `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:validates_contract_family`,
        'validates_contract_family',
        descriptor.filePath,
        resolved.filePath,
        0.68,
        'artifact-backed',
        'typed-request-parameter',
        {
          filePath: descriptor.filePath,
          line: lineOf(descriptor.content, match.index),
          note: `${match[1]}(${resolved.className} $${paramMatch[2]})`,
        },
        extractedAt
      );
    }
  }

  RESOURCE_INSTANTIATION_RE.lastIndex = 0;
  while ((match = RESOURCE_INSTANTIATION_RE.exec(descriptor.content)) !== null) {
    const classRef = match[1] ?? match[2];
    if (!classRef) continue;
    const resolved = resolvePhpReference(classRef, descriptor, index);
    if (!isCrossModuleReference(descriptor, resolved) || !isResourceLike(resolved)) continue;

    collector.add(
      `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:emits_resource_family`,
      'emits_resource_family',
      descriptor.filePath,
      resolved.filePath,
      0.72,
      'artifact-backed',
      'resource-emission',
      {
        filePath: descriptor.filePath,
        line: lineOf(descriptor.content, match.index),
        note: classRef,
      },
      extractedAt
    );
  }

  if (isModelTransformer(descriptor.filePath)) {
    for (const [alias] of descriptor.imports) {
      const resolved = resolvePhpReference(alias, descriptor, index);
      if (!isCrossModuleReference(descriptor, resolved) || !isModelLike(resolved)) continue;

      collector.add(
        `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:transforms_model`,
        'transforms_model',
        descriptor.filePath,
        resolved.filePath,
        0.75,
        'artifact-backed',
        'cross-module-model-transform',
        {
          filePath: descriptor.filePath,
          line: lineOfUse(descriptor.content, resolved.fqcn ?? resolved.className),
          note: resolved.className,
        },
        extractedAt
      );
    }
  }
}

function collectPipelineEvidence(
  descriptor: PhpFileDescriptor,
  index: PhpIndex,
  collector: EdgeCollector,
  extractedAt: number
): void {
  const contextEdgeType = inferPipelineEdgeType(descriptor.filePath);
  if (!contextEdgeType) return;

  for (const [alias, fqcn] of descriptor.imports) {
    const resolved = resolvePhpReference(alias, descriptor, index);
    if (!isCrossModuleReference(descriptor, resolved)) continue;
    if (!isPipelineRelevantTarget(resolved)) continue;

    collector.add(
      `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:${contextEdgeType}`,
      contextEdgeType,
      descriptor.filePath,
      resolved.filePath,
      0.84,
      'artifact-backed',
      'pipeline-lineage-import',
      {
        filePath: descriptor.filePath,
        line: lineOfUse(descriptor.content, fqcn),
        note: fqcn,
      },
      extractedAt
    );
  }
}

function collectDispatchEvidence(
  descriptor: PhpFileDescriptor,
  index: PhpIndex,
  collector: EdgeCollector,
  extractedAt: number,
  pattern: RegExp,
  evidenceKind: string,
  confidence: number
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(descriptor.content)) !== null) {
    const resolved = resolvePhpReference(match[1], descriptor, index);
    if (!isCrossModuleReference(descriptor, resolved)) continue;

    const edgeType = isJobLike(resolved, index)
      ? 'dispatches_job'
      : isEventLike(resolved, index)
        ? 'emits_event'
        : null;
    if (!edgeType) continue;

    collector.add(
      `${fileNodeId(descriptor.filePath)}→${fileNodeId(resolved.filePath)}:${edgeType}`,
      edgeType,
      descriptor.filePath,
      resolved.filePath,
      confidence,
      'artifact-backed',
      evidenceKind,
      {
        filePath: descriptor.filePath,
        line: lineOf(descriptor.content, match.index),
        note: match[0].trim(),
      },
      extractedAt
    );
  }
}

function buildPhpIndex(context: AssociationContext, patterns: string[]): PhpIndex {
  const descriptors = context.entries
    .filter((entry) => entry.languageId === 'php')
    .map((entry) => describePhpEntry(entry, context.rootPath, patterns))
    .filter((descriptor): descriptor is PhpFileDescriptor => descriptor !== null);

  const byFqcn = new Map<string, string>();
  const byShortName = new Map<string, string[]>();
  const fileContentByPath = new Map<string, string>();

  for (const descriptor of descriptors) {
    fileContentByPath.set(descriptor.filePath, descriptor.content);
    for (const fqcn of descriptor.declaredFqcns) {
      byFqcn.set(fqcn, descriptor.filePath);
      const short = shortName(fqcn);
      const existing = byShortName.get(short);
      if (existing) {
        existing.push(descriptor.filePath);
      } else {
        byShortName.set(short, [descriptor.filePath]);
      }
    }
  }

  return {
    descriptors,
    byFqcn,
    byShortName,
    fileContentByPath,
    patterns,
  };
}

function describePhpEntry(
  entry: AssociationContext['entries'][number],
  rootPath: string,
  patterns: string[]
): PhpFileDescriptor | null {
  const content = (entry.metadata?.content as string | undefined) ?? '';
  if (!content) return null;

  const namespace = PHP_NAMESPACE_RE.exec(content)?.[1];
  const imports = parseUseStatements(content);
  const declaredFqcns: string[] = [];

  PHP_DECLARATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PHP_DECLARATION_RE.exec(content)) !== null) {
    declaredFqcns.push(namespace ? `${namespace}\\${match[1]}` : match[1]);
  }

  return {
    filePath: entry.filePath,
    absolutePath: join(rootPath, entry.filePath),
    content,
    namespace,
    imports,
    declaredFqcns,
    sourceModule: resolveModule(join(rootPath, entry.filePath), rootPath, patterns),
    sourceBoundaryKind: classifySourceBoundaryKind(entry.filePath),
  };
}

function parseUseStatements(content: string): Map<string, string> {
  const imports = new Map<string, string>();
  PHP_USE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PHP_USE_RE.exec(content)) !== null) {
    const statement = match[1].trim();
    if (statement.startsWith('function ') || statement.startsWith('const ')) continue;

    if (statement.includes('{') && statement.includes('}')) {
      const prefix = statement.slice(0, statement.indexOf('{')).replace(/\\$/, '');
      const members = statement
        .slice(statement.indexOf('{') + 1, statement.lastIndexOf('}'))
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      for (const member of members) {
        const [namePart, aliasPart] = member.split(/\s+as\s+/i);
        const fqcn = `${prefix}\\${namePart.trim().replace(/^\\/, '')}`;
        const alias = (aliasPart?.trim() || shortName(namePart.trim())).replace(/^\\/, '');
        imports.set(alias, fqcn);
      }
      continue;
    }

    const [namePart, aliasPart] = statement.split(/\s+as\s+/i);
    const fqcn = namePart.trim().replace(/^\\/, '');
    imports.set((aliasPart?.trim() || shortName(fqcn)).replace(/^\\/, ''), fqcn);
  }

  return imports;
}

function resolvePhpReference(
  rawRef: string,
  descriptor: PhpFileDescriptor,
  index: PhpIndex
): ResolvedPhpReference {
  const className = normalizeTypeName(rawRef);
  if (!className || BUILTIN_TYPES.has(className.toLowerCase())) {
    return { className, targetModule: null };
  }

  let fqcn: string | undefined;
  if (className.includes('\\')) {
    fqcn = className.replace(/^\\/, '');
  } else if (descriptor.imports.has(className)) {
    fqcn = descriptor.imports.get(className);
  } else if (descriptor.namespace) {
    fqcn = `${descriptor.namespace}\\${className}`;
  }

  let filePath: string | undefined;
  if (fqcn) {
    filePath = index.byFqcn.get(fqcn);
  }
  if (!filePath) {
    const candidates = index.byShortName.get(shortName(className));
    if (candidates?.length === 1) filePath = candidates[0];
  }

  const targetModule = filePath
    ? resolveModule(
        join('/', filePath),
        '/',
        index.patterns.map((pattern) => stripLeadingSegments(pattern))
      )
    : null;

  return { className, fqcn, filePath, targetModule };
}

function stripLeadingSegments(pattern: string): string {
  return pattern.replace(/^[./]+/, '');
}

function detectPatterns(context: AssociationContext): string[] {
  const detected = detectModuleBoundaries(context.rootPath);
  if (detected.length > 0) return detected;

  const patterns = new Set<string>();
  for (const entry of context.entries) {
    if (entry.filePath.startsWith('src/Module/')) patterns.add('src/Module/{name}');
    if (entry.filePath.startsWith('app/Module/')) patterns.add('app/Module/{name}');
    if (entry.filePath.startsWith('app/Modules/')) patterns.add('app/Modules/{name}');
    if (entry.filePath.startsWith('packages/')) patterns.add('packages/{name}');
    if (entry.filePath.startsWith('apps/')) patterns.add('apps/{name}');
    if (entry.filePath.startsWith('libs/')) patterns.add('libs/{name}');
  }

  return Array.from(patterns);
}

function isCrossModuleReference(
  descriptor: PhpFileDescriptor,
  resolved: ResolvedPhpReference
): resolved is ResolvedPhpReference & { filePath: string; targetModule: string } {
  return Boolean(
    resolved.filePath &&
    resolved.targetModule &&
    resolved.filePath !== descriptor.filePath &&
    ((descriptor.sourceModule && resolved.targetModule !== descriptor.sourceModule) ||
      descriptor.sourceBoundaryKind === 'glue')
  );
}

function classifySourceBoundaryKind(filePath: string): 'owned-region' | 'glue' | 'unresolved' {
  if (/^src\/Module\//.test(filePath) || /^app\/Modules?\//.test(filePath)) {
    return 'owned-region';
  }

  if (
    filePath.startsWith('routes/') ||
    filePath.startsWith('app/Providers/') ||
    filePath.startsWith('src/Providers/') ||
    filePath === 'src/CoreServiceProvider.php' ||
    filePath.endsWith('RouteServiceProvider.php') ||
    filePath.endsWith('EventServiceProvider.php') ||
    (/\/(Http\/Controllers|Controllers)\//.test(filePath) && !/\/Module\//.test(filePath)) ||
    filePath.startsWith('bootstrap/') ||
    filePath.startsWith('public/') ||
    /\/(Adapters?|Transport)\//.test(filePath)
  ) {
    return 'glue';
  }

  return 'unresolved';
}

function normalizeTypeName(value: string): string {
  return value.replace(/[?&|].*$/, '').trim();
}

function shortName(value: string): string {
  const normalized = value.replace(/^\\/, '');
  const segments = normalized.split('\\');
  return segments[segments.length - 1];
}

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length - 1;
}

function lineOfUse(content: string, fqcn: string): number | undefined {
  const idx = content.indexOf(fqcn);
  return idx >= 0 ? lineOf(content, idx) : undefined;
}

function isJobLike(resolved: ResolvedPhpReference, index: PhpIndex): boolean {
  return (
    /(^|\\)(.*Job)$/.test(resolved.fqcn ?? resolved.className) ||
    /\/Jobs\//.test(resolved.filePath ?? '') ||
    index.fileContentByPath.get(resolved.filePath ?? '')?.includes('ShouldQueue') === true
  );
}

function isEventLike(resolved: ResolvedPhpReference, index: PhpIndex): boolean {
  return (
    /(^|\\)(.*Event)$/.test(resolved.fqcn ?? resolved.className) ||
    /\/Events\//.test(resolved.filePath ?? '') ||
    index.fileContentByPath.get(resolved.filePath ?? '')?.includes('Dispatchable') === true
  );
}

function isRequestLike(resolved: ResolvedPhpReference): boolean {
  return (
    /(Request|FormRequest)$/.test(resolved.className) ||
    /\/Requests?\//.test(resolved.filePath ?? '')
  );
}

function isResourceLike(resolved: ResolvedPhpReference): boolean {
  return (
    /(Resource|Collection)$/.test(resolved.className) ||
    /\/Resources?\//.test(resolved.filePath ?? '')
  );
}

function isSchemaLike(resolved: ResolvedPhpReference): boolean {
  return (
    /(Schema|Contract|Interface)$/.test(resolved.className) ||
    /\/Schemas?\//.test(resolved.filePath ?? '')
  );
}

function isContractLike(resolved: ResolvedPhpReference): boolean {
  return (
    /(Request|Resource|Data|DTO|Dto|Schema|Contract|Transformer|ViewModel)$/.test(
      resolved.className
    ) ||
    /\/(Requests?|Resources?|Data|DTO|Dtos|Schemas?|Contracts?)\//.test(resolved.filePath ?? '')
  );
}

function isModelLike(resolved: ResolvedPhpReference): boolean {
  return (
    /(^|\\)[A-Za-z_][A-Za-z0-9_]*$/.test(resolved.className) &&
    /\/Models?\//.test(resolved.filePath ?? '')
  );
}

function isModelTransformer(filePath: string): boolean {
  return /(Resource|Data|Transformer|ViewModel)\.php$/.test(filePath);
}

function inferPipelineEdgeType(filePath: string): EdgeType | null {
  if (/(^|\/)(Import|Imports|ListingImport|BulkImport|CsvImport)/i.test(filePath)) {
    return 'imports_pipeline_artifact';
  }
  if (/(^|\/)(Export|Exports)/i.test(filePath)) {
    return 'exports_pipeline_artifact';
  }
  if (/(^|\/)(Report|Reports|Analytics)/i.test(filePath)) {
    return 'consumes_reporting_source';
  }
  if (/(^|\/)(Sync|Synchronize|Webhook|Webhooks|ExternalApi|Integration)/i.test(filePath)) {
    return 'syncs_external_record';
  }
  return null;
}

function isPipelineRelevantTarget(resolved: ResolvedPhpReference): boolean {
  return isContractLike(resolved) || isModelLike(resolved) || /Service$/.test(resolved.className);
}
