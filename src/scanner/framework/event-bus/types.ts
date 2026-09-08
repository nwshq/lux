import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../../contracts/program.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import type { Extraction } from '../../ast/extract.js';
import type { FrameworkNodeV1, ResolvedBindingV1 } from '../../react/types.js';

export interface EventBusCatalogEntryV1 {
  busId: string;
  declarationFile: string;
  exportName: string;
  eventKeys: string[];
  methods: {
    publish: string[];
    subscribe: string[];
  };
  evidence: SourceLocationV1[];
}

export interface EventBusCallFactV1 {
  kind: 'event-bus-call';
  filePath: string;
  ownerExport: string;
  busBinding?: ResolvedBindingV1;
  busId?: string;
  method: string;
  operation: 'publish' | 'subscribe';
  eventKey?: string;
  location: SourceLocationV1;
}

export interface EventBusInputV1 {
  rootPath: string;
  files: readonly string[];
  project: ProjectResolutionContextV1;
  /** Owner-reviewed entries may seed discovery; discovered entries are merged by exact bus identity. */
  catalog: readonly EventBusCatalogEntryV1[];
  /** Optional bounded source cache. When absent the leaf reads only the listed, root-confined files. */
  sources?: ReadonlyMap<string, string>;
  /** Optional shared extraction cache used for exact owner declarations. */
  extractions?: ReadonlyMap<string, Extraction>;
}

export interface EventBusResultV1 {
  calls: EventBusCallFactV1[];
  nodes: FrameworkNodeV1[];
  edges: StructuralRelationEdge[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

export interface EventBusAnalyzerV1 {
  analyze(input: EventBusInputV1): Promise<EventBusResultV1>;
}

export interface EventBusCatalogResultV1 {
  catalog: EventBusCatalogEntryV1[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

export interface EventBusFactResultV1 {
  calls: EventBusCallFactV1[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}
