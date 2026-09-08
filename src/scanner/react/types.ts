import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../contracts/program.js';
import type { StructuralNode, StructuralNodeType } from '../../db/types.js';
import type { StructuralRelationEdge } from '../associations/types.js';
import type { Extraction } from '../ast/extract.js';

export type ReactFactV1 =
  | ReactComponentFactV1
  | ReactRenderFactV1
  | ReactLazyFactV1
  | ReactHookCallFactV1
  | ReactContextFactV1
  | ReactContextUseFactV1;

export interface ResolvedBindingV1 {
  localName: string;
  importedName: string;
  sourceSpecifier: string;
  targetFile: string;
  targetExport: string;
  evidenceFile?: string;
}

export interface ReactComponentFactV1 {
  kind: 'react-component';
  filePath: string;
  exportName: string;
  localName: string;
  declaration: SourceLocationV1;
  form: 'function' | 'arrow' | 'class' | 'memo' | 'forward-ref' | 'file-route';
}

export interface ReactRenderFactV1 {
  kind: 'react-render';
  filePath: string;
  ownerExport: string;
  jsxName: string;
  binding?: ResolvedBindingV1;
  location: SourceLocationV1;
  form: 'jsx' | 'create-element';
}

export interface ReactLazyFactV1 {
  kind: 'react-lazy';
  filePath: string;
  ownerExport: string;
  localName: string;
  specifier?: string;
  targetExport?: string;
  location: SourceLocationV1;
}

export interface ReactHookCallFactV1 {
  kind: 'react-hook-call';
  filePath: string;
  ownerExport: string;
  localName: string;
  binding?: ResolvedBindingV1;
  location: SourceLocationV1;
}

export interface ReactContextFactV1 {
  kind: 'react-context';
  filePath: string;
  exportName: string;
  localName: string;
  declaration: SourceLocationV1;
}

export interface ReactContextUseFactV1 {
  kind: 'react-context-use';
  filePath: string;
  ownerExport: string;
  mode: 'provider' | 'use-context' | 'consumer';
  contextBinding?: ResolvedBindingV1;
  contextLocalName: string;
  location: SourceLocationV1;
}

export interface FrameworkNodeV1 {
  id: string;
  type: StructuralNodeType;
  name: string;
  filePath: string;
  languageId: 'typescript' | 'javascript';
  metadata: Readonly<Record<string, unknown>>;
}

export interface ReactAnalysisInputV1 {
  rootPath: string;
  files: readonly string[];
  project: ProjectResolutionContextV1;
  /** Shared Tranche 2 extraction cache; required to avoid reparsing in one rebuild. */
  extractions?: ReadonlyMap<string, Extraction>;
  /** In-memory source text keyed by canonical repository-relative path. */
  sources?: ReadonlyMap<string, string>;
}

export interface ReactAnalysisResultV1 {
  facts: ReactFactV1[];
  nodes: FrameworkNodeV1[];
  edges: StructuralRelationEdge[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

export interface ReactFactExtractorV1 {
  extract(input: ReactAnalysisInputV1): Promise<{
    facts: ReactFactV1[];
    dependencies: string[];
    diagnostics: SourceDiagnosticV1[];
  }>;
}

export interface ReactRelationshipResolverV1 {
  resolve(
    facts: readonly ReactFactV1[],
    project: ProjectResolutionContextV1
  ): Promise<{
    nodes: FrameworkNodeV1[];
    edges: StructuralRelationEdge[];
    diagnostics: SourceDiagnosticV1[];
  }>;
}

export interface ReactFrameworkAnalyzerV1 {
  analyze(input: ReactAnalysisInputV1): Promise<ReactAnalysisResultV1>;
}

export function toStructuralNode(node: FrameworkNodeV1, updatedAt: number): StructuralNode {
  return {
    id: node.id,
    node_type: node.type,
    file_path: node.filePath,
    language_id: node.languageId,
    symbol_name: node.name,
    metadata: JSON.stringify(node.metadata),
    updated_at: updatedAt,
  };
}
