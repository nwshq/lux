import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../../contracts/program.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import type { FrameworkNodeV1 } from '../../react/types.js';

export interface ExpoRouteV1 {
  id: string;
  filePath: string;
  canonicalPath: string;
  segmentPath: string[];
  groups: string[];
  params: Array<{ name: string; rest: boolean; optional: boolean }>;
  layouts: string[];
  kind: 'route' | 'layout' | 'not-found';
  componentExport: 'default';
  location: SourceLocationV1;
}

export interface ExpoDestinationV1 {
  pathname: string;
  params: Record<string, string>;
  location: SourceLocationV1;
  source: 'link' | 'redirect' | 'router-push' | 'router-replace' | 'router-navigate';
}

export interface ExpoRouterInputV1 {
  rootPath: string;
  appRoots: readonly string[];
  files: readonly string[];
  project: ProjectResolutionContextV1;
  sources?: ReadonlyMap<string, string>;
}

export interface ExpoRouterResultV1 {
  routes: ExpoRouteV1[];
  destinations: ExpoDestinationV1[];
  nodes: FrameworkNodeV1[];
  edges: StructuralRelationEdge[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

export interface ExpoRouterAnalyzerV1 {
  analyze(input: ExpoRouterInputV1): Promise<ExpoRouterResultV1>;
}
