import type { StructuralNode } from '../../../db/types.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../../contracts/program.js';
import type { Extraction } from '../../ast/extract.js';

export interface MobileBindingV1 {
  localName: string;
  importedName: string;
  sourceSpecifier: string;
}

export interface MobileDeclarationV1 {
  filePath: string;
  localName: string;
  exportName: string;
  location: SourceLocationV1;
}

export interface MobileRepositoryInterfaceFactV1 extends MobileDeclarationV1 {
  kind: 'mobile-repository-interface';
}

export interface MobileRepositoryImplementationFactV1 extends MobileDeclarationV1 {
  kind: 'mobile-repository-implementation';
  interfaceName: string;
  interfaceBinding?: MobileBindingV1;
  interfaceLocation: SourceLocationV1;
}

export interface MobileConstructionFactV1 {
  kind: 'mobile-construction';
  filePath: string;
  owner?: MobileDeclarationV1;
  assignedName?: string;
  constructedName: string;
  constructedBinding?: MobileBindingV1;
  arguments: string[];
  location: SourceLocationV1;
}

export interface MobileConstructorDependencyFactV1 extends MobileDeclarationV1 {
  kind: 'mobile-constructor-dependency';
  parameterName: string;
  dependencyName: string;
  dependencyBinding?: MobileBindingV1;
  dependencyLocation: SourceLocationV1;
}

export interface MobileViewModelFactV1 extends MobileDeclarationV1 {
  kind: 'mobile-view-model';
}

export interface MobileViewModelUseFactV1 {
  kind: 'mobile-view-model-use';
  filePath: string;
  owner: MobileDeclarationV1;
  viewModelName: string;
  viewModelBinding?: MobileBindingV1;
  mode: 'direct' | 'hook-return';
  hookName?: string;
  hookBinding?: MobileBindingV1;
  location: SourceLocationV1;
}

export type MobileFactV1 =
  | MobileRepositoryInterfaceFactV1
  | MobileRepositoryImplementationFactV1
  | MobileConstructionFactV1
  | MobileConstructorDependencyFactV1
  | MobileViewModelFactV1
  | MobileViewModelUseFactV1;

export interface MobileAnalysisInputV1 {
  rootPath: string;
  files: readonly string[];
  project: ProjectResolutionContextV1;
  /** Shared source cache. The mobile leaf never reads outside this bounded input. */
  sources?: ReadonlyMap<string, string>;
  /** Shared Tranche 2 extraction cache. The mobile leaf never reparses source. */
  extractions?: ReadonlyMap<string, Extraction>;
}

export interface MobileExtractionResultV1 {
  facts: MobileFactV1[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

export interface MobileResolutionResultV1 {
  nodes: StructuralNode[];
  edges: StructuralRelationEdge[];
  diagnostics: SourceDiagnosticV1[];
}

export interface MobileAnalysisResultV1
  extends MobileExtractionResultV1, MobileResolutionResultV1 {}

export interface MobileFactExtractorV1 {
  extract(input: MobileAnalysisInputV1): Promise<MobileExtractionResultV1>;
}

export interface MobileRelationshipResolverV1 {
  resolve(
    facts: readonly MobileFactV1[],
    project: ProjectResolutionContextV1
  ): Promise<MobileResolutionResultV1>;
}
