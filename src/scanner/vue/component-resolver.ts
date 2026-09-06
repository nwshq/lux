import type { StructuralRelationEdge } from '../associations/types.js';
import type { RelationshipResolverV1 } from '../adapters/types.js';
import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceFactsV1,
  SourceLocationV1,
} from '../contracts/program.js';
import { programEdgeId, vueComponentId } from '../identity/program-identity.js';
import { resolveProjectBinding } from '../project-resolution/resolver.js';
import { isVueSfcFacts, type VueImportBindingV1, type VueSfcFactsV1 } from './types.js';

const EDGE_TYPE = 'renders_component' as const;
const CONFIDENCE = 0.9;

const HTML_ELEMENTS = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

const SVG_ELEMENTS = new Set([
  'svg',
  'animate',
  'animatemotion',
  'animatetransform',
  'circle',
  'clippath',
  'defs',
  'desc',
  'ellipse',
  'feblend',
  'fecolormatrix',
  'fecomponenttransfer',
  'fecomposite',
  'feconvolvematrix',
  'fediffuselighting',
  'fedisplacementmap',
  'fedistantlight',
  'fedropshadow',
  'feflood',
  'fefunca',
  'fefuncb',
  'fefuncg',
  'fefuncr',
  'fegaussianblur',
  'feimage',
  'femerge',
  'femergenode',
  'femorphology',
  'feoffset',
  'fepointlight',
  'fespecularlighting',
  'fespotlight',
  'fetile',
  'feturbulence',
  'filter',
  'foreignobject',
  'g',
  'image',
  'line',
  'lineargradient',
  'marker',
  'mask',
  'metadata',
  'mpath',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialgradient',
  'rect',
  'set',
  'stop',
  'switch',
  'symbol',
  'text',
  'textpath',
  'tspan',
  'use',
  'view',
]);

const VUE_BUILT_INS = new Set([
  'component',
  'slot',
  'template',
  'teleport',
  'suspense',
  'keepalive',
  'transition',
  'transitiongroup',
]);

export interface VueComponentResolverOptions {
  onDiagnostic?: (diagnostic: SourceDiagnosticV1) => void;
  now?: () => number;
}

interface BindingCandidate {
  kind: 'import' | 'async-import';
  localName: string;
  importedName: string;
  specifier: string;
  location: SourceLocationV1;
  registration?: { name: string; localName: string };
}

interface ResolvedCandidate {
  child: VueSfcFactsV1;
  binding: BindingCandidate;
  evidenceFile?: string;
}

/** Resolve compiler-produced Vue facts into deterministic parent-to-child render edges. */
export class VueComponentResolver implements RelationshipResolverV1 {
  readonly id = 'vue-component';

  constructor(private readonly options: VueComponentResolverOptions = {}) {}

  resolve(
    facts: readonly SourceFactsV1[],
    project: ProjectResolutionContextV1
  ): Promise<StructuralRelationEdge[]> {
    const vueFacts = facts.filter(isVueSfcFacts);
    const componentsByPath = canonicalComponentIndex(vueFacts, this.options.onDiagnostic);
    const edges = new Map<string, StructuralRelationEdge>();
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);

    for (const parent of [...vueFacts].sort((left, right) =>
      left.filePath.localeCompare(right.filePath)
    )) {
      const canonicalParentId = vueComponentId(parent.filePath);
      if (parent.componentId !== canonicalParentId) {
        this.report(
          'vue-component-noncanonical',
          `Component ${parent.filePath} has a non-canonical component identity.`,
          { filePath: parent.filePath, line: 1, column: 0 }
        );
        continue;
      }

      for (const element of parent.templateElements) {
        const requestedName = templateComponentName(element.tag, element.staticIs);
        if (requestedName === null) {
          if (normalizeName(element.tag) === 'component') {
            this.report(
              'vue-component-dynamic',
              'Dynamic <component> target cannot form a deterministic render edge.',
              element.location
            );
          }
          continue;
        }
        if (isPlatformOrBuiltIn(requestedName)) continue;

        const candidates = bindingCandidates(parent, requestedName);
        if (candidates.length === 0) {
          this.report(
            'vue-component-unresolved',
            `Template component ${requestedName} has no unique static local binding.`,
            element.location
          );
          continue;
        }
        if (candidates.length > 1) {
          this.report(
            'vue-component-ambiguous',
            `Template component ${requestedName} matches multiple local bindings.`,
            element.location
          );
          continue;
        }

        const resolved = this.resolveCandidate(candidates[0], parent, project, componentsByPath);
        if (!resolved) continue;

        const edgeId = programEdgeId(
          EDGE_TYPE,
          canonicalParentId,
          resolved.child.componentId,
          this.id
        );
        const locations = evidenceLocations(parent, element.location, resolved);
        const existing = edges.get(edgeId);
        if (existing) {
          existing.provenance.evidenceLocations = mergeEvidenceLocations(
            existing.provenance.evidenceLocations,
            locations
          );
          continue;
        }

        edges.set(edgeId, {
          id: edgeId,
          edgeType: EDGE_TYPE,
          sourceNodeId: canonicalParentId,
          targetNodeId: resolved.child.componentId,
          sourceLanguage: 'vue',
          targetLanguage: 'vue',
          confidence: CONFIDENCE,
          confidenceClass: 'framework-inferred',
          provenance: {
            resolver: this.id,
            evidenceKind:
              resolved.binding.kind === 'async-import'
                ? 'vue-static-async-component'
                : 'vue-static-component-binding',
            evidenceLocations: locations,
            extractedAt: now,
          },
        });
      }
    }

    return Promise.resolve(
      [...edges.values()].sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  private resolveCandidate(
    binding: BindingCandidate,
    parent: VueSfcFactsV1,
    project: ProjectResolutionContextV1,
    componentsByPath: ReadonlyMap<string, VueSfcFactsV1>
  ): ResolvedCandidate | undefined {
    const resolution = resolveProjectBinding(
      {
        importerFile: parent.filePath,
        specifier: binding.specifier,
        importedName: binding.importedName,
        mode: binding.kind === 'async-import' ? 'dynamic-import' : 'import',
      },
      project
    );

    if (resolution.module.status !== 'resolved') {
      this.report(
        resolution.module.status === 'ambiguous'
          ? 'vue-component-ambiguous'
          : 'vue-component-unresolved',
        `Cannot resolve component module ${binding.specifier}: ${resolution.module.status}.`,
        binding.location
      );
      return undefined;
    }
    if (resolution.exported?.status === 'ambiguous') {
      this.report(
        'vue-component-ambiguous',
        `Component export ${binding.importedName} from ${binding.specifier} is ambiguous.`,
        binding.location
      );
      return undefined;
    }
    if (resolution.exported?.status === 'cycle') {
      this.report(
        'vue-component-unresolved',
        `Component export ${binding.importedName} from ${binding.specifier} contains a cycle.`,
        binding.location
      );
      return undefined;
    }

    const targetPath =
      resolution.exported?.status === 'resolved'
        ? resolution.exported.target.filePath
        : resolution.module.targetFile;
    const child = componentsByPath.get(targetPath);
    if (!child) {
      this.report(
        'vue-component-unresolved',
        `Resolved target ${targetPath} is not a materialized Vue SFC.`,
        binding.location
      );
      return undefined;
    }

    return { child, binding, evidenceFile: resolution.module.evidenceFile };
  }

  private report(code: string, message: string, location: SourceLocationV1): void {
    this.options.onDiagnostic?.({ code, message, location });
  }
}

function canonicalComponentIndex(
  facts: readonly VueSfcFactsV1[],
  onDiagnostic?: (diagnostic: SourceDiagnosticV1) => void
): ReadonlyMap<string, VueSfcFactsV1> {
  const byPath = new Map<string, VueSfcFactsV1>();
  for (const fact of [...facts].sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
  )) {
    if (fact.componentId !== vueComponentId(fact.filePath)) {
      onDiagnostic?.({
        code: 'vue-component-noncanonical',
        message: `Component ${fact.filePath} has a non-canonical component identity.`,
        location: { filePath: fact.filePath, line: 1, column: 0 },
      });
      continue;
    }
    if (byPath.has(fact.filePath)) {
      onDiagnostic?.({
        code: 'vue-component-ambiguous',
        message: `Multiple Vue facts claim ${fact.filePath}.`,
        location: { filePath: fact.filePath, line: 1, column: 0 },
      });
      byPath.delete(fact.filePath);
      continue;
    }
    byPath.set(fact.filePath, fact);
  }
  return byPath;
}

function templateComponentName(tag: string, staticIs?: string): string | null {
  if (normalizeName(tag) === 'component') return staticIs?.trim() || null;
  return tag.trim() || null;
}

function bindingCandidates(parent: VueSfcFactsV1, requestedName: string): BindingCandidate[] {
  const registrations = Object.entries(parent.optionsComponents).filter(
    ([registeredName]) => normalizeName(registeredName) === normalizeName(requestedName)
  );

  if (registrations.length > 1)
    return registrations.flatMap(([name, local]) =>
      localBindingCandidates(parent, local, { name, localName: local })
    );
  if (registrations.length === 1) {
    const [name, localName] = registrations[0];
    return localBindingCandidates(parent, localName, { name, localName });
  }

  // A non-empty registration map identifies Options API facts. Components not in that map are not
  // visible to its template merely because they were imported.
  if (Object.keys(parent.optionsComponents).length > 0) return [];
  return localBindingCandidates(parent, requestedName);
}

function localBindingCandidates(
  parent: VueSfcFactsV1,
  localName: string,
  registration?: { name: string; localName: string }
): BindingCandidate[] {
  const normalized = normalizeName(localName);
  const imported = parent.imports
    .filter((binding) => normalizeName(binding.localName) === normalized)
    .map((binding) => importCandidate(binding, registration));
  const asynchronous = parent.calls
    .filter(
      (call) => call.localBinding !== undefined && normalizeName(call.localBinding) === normalized
    )
    .filter((call) => isVueAsyncComponentCall(parent, call.callee))
    .flatMap((call): BindingCandidate[] => {
      if (!call.localBinding || !call.firstStaticString) return [];
      return [
        {
          kind: 'async-import',
          localName: call.localBinding,
          importedName: 'default',
          specifier: call.firstStaticString,
          location: call.location,
          ...(registration ? { registration } : {}),
        },
      ];
    });

  const unique = new Map<string, BindingCandidate>();
  for (const candidate of [...imported, ...asynchronous]) {
    const key = [
      candidate.kind,
      candidate.localName,
      candidate.importedName,
      candidate.specifier,
    ].join('\0');
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) =>
    [left.kind, left.specifier, left.importedName, left.localName]
      .join('\0')
      .localeCompare([right.kind, right.specifier, right.importedName, right.localName].join('\0'))
  );
}

function importCandidate(
  binding: VueImportBindingV1,
  registration?: { name: string; localName: string }
): BindingCandidate {
  return {
    kind: 'import',
    localName: binding.localName,
    importedName: binding.importedName,
    specifier: binding.specifier,
    location: binding.location,
    ...(registration ? { registration } : {}),
  };
}

function isVueAsyncComponentCall(parent: VueSfcFactsV1, callee: string): boolean {
  return parent.imports.some(
    (binding) =>
      binding.specifier === 'vue' &&
      binding.importedName === 'defineAsyncComponent' &&
      binding.localName === callee
  );
}

function evidenceLocations(
  parent: VueSfcFactsV1,
  useLocation: SourceLocationV1,
  resolved: ResolvedCandidate
): StructuralRelationEdge['provenance']['evidenceLocations'] {
  const registration = resolved.binding.registration;
  const locations: StructuralRelationEdge['provenance']['evidenceLocations'] = [
    {
      filePath: useLocation.filePath,
      line: useLocation.line,
      note: `static template use of ${registration?.name ?? resolved.binding.localName}`,
    },
    {
      filePath: resolved.binding.location.filePath,
      line: resolved.binding.location.line,
      note: registration
        ? `Options components registration ${registration.name}: ${registration.localName} and resolved ${resolved.binding.kind}`
        : `resolved ${resolved.binding.kind} ${resolved.binding.localName} from ${resolved.binding.specifier}`,
    },
  ];
  if (resolved.evidenceFile) {
    locations.push({
      filePath: resolved.evidenceFile,
      note: `project resolution evidence for ${resolved.binding.specifier}`,
    });
  }
  // Facts must retain original SFC paths, never virtual script/template paths.
  if (
    !useLocation.filePath.endsWith('.vue') ||
    !resolved.binding.location.filePath.endsWith('.vue')
  ) {
    return locations.filter((location) => location.filePath !== parent.filePath || !location.note);
  }
  return locations;
}

function mergeEvidenceLocations(
  left: StructuralRelationEdge['provenance']['evidenceLocations'],
  right: StructuralRelationEdge['provenance']['evidenceLocations']
): StructuralRelationEdge['provenance']['evidenceLocations'] {
  const merged = new Map<string, (typeof left)[number]>();
  for (const location of [...left, ...right]) {
    const key = `${location.filePath}\0${location.line ?? ''}\0${location.note ?? ''}`;
    merged.set(key, location);
  }
  return [...merged.values()].sort((a, b) =>
    `${a.filePath}\0${a.line ?? ''}\0${a.note ?? ''}`.localeCompare(
      `${b.filePath}\0${b.line ?? ''}\0${b.note ?? ''}`
    )
  );
}

function normalizeName(name: string): string {
  return name.replaceAll('-', '').toLocaleLowerCase('en-US');
}

function isPlatformOrBuiltIn(name: string): boolean {
  const lower = name.toLocaleLowerCase('en-US');
  const normalized = normalizeName(name);
  return HTML_ELEMENTS.has(lower) || SVG_ELEMENTS.has(lower) || VUE_BUILT_INS.has(normalized);
}
