import type {
  DeclarationFactV1,
  ReferenceFactV1,
  SourceDiagnosticV1,
  SourceFactsV1,
  SourceLocationV1,
} from '../contracts/program.js';
import type { StructuralRelationEdge } from '../associations/types.js';
export type SupportedProgramLanguage = 'go' | 'python';
export type LanguageProducer =
  | 'go-deterministic'
  | 'gopls'
  | 'go-frameworks'
  | 'python-deterministic'
  | 'pyright'
  | 'python-frameworks';
export interface LanguageProjectV1 {
  schemaVersion: 1;
  languageId: SupportedProgramLanguage;
  corpusRoot: string;
  allowedRoots: readonly string[];
  sourceRoots: readonly string[];
  manifestFiles: readonly string[];
  files: readonly string[];
  fingerprintInputs: readonly string[];
}
export interface ImportBindingV1 {
  local: string;
  imported: string;
  module: string;
  kind: 'default' | 'named' | 'namespace' | 'side-effect';
  location: SourceLocationV1;
}
export interface CallSiteV1 {
  fromLocalId: string;
  rawCallee: string;
  receiver?: string;
  member: string;
  location: SourceLocationV1;
}
export interface LanguageFileFactsV1 {
  schemaVersion: 1;
  languageId: SupportedProgramLanguage;
  filePath: string;
  packageOrModule: string;
  declarations: DeclarationFactV1[];
  references: ReferenceFactV1[];
  imports: ImportBindingV1[];
  calls: CallSiteV1[];
  diagnostics: SourceDiagnosticV1[];
  dependencies: string[];
  generated: boolean;
  conditional: boolean;
  test: boolean;
}
export interface GoProjectV1 extends LanguageProjectV1 {
  languageId: 'go';
  modulePath: string;
  goModPath: string;
  packages: ReadonlyMap<string, readonly string[]>;
}
export interface LanguageNodeV1 {
  id: string;
  nodeType: 'symbol' | 'artifact' | 'capability-surface';
  languageId: SupportedProgramLanguage | 'cli' | 'grpc' | 'http';
  filePath?: string;
  symbolName: string;
  symbolKind: string;
  qualifiedName: string;
  metadata: Readonly<Record<string, unknown>>;
}
export interface LanguageResolutionV1 {
  facts: readonly LanguageFileFactsV1[];
  nodes: readonly LanguageNodeV1[];
  edges: readonly StructuralRelationEdge[];
  diagnostics: readonly SourceDiagnosticV1[];
  producerRan: Readonly<Record<LanguageProducer, boolean>>;
}
export interface DeterministicLanguageAdapterV1 {
  readonly languageId: SupportedProgramLanguage;
  discover(rootPath: string, allowedRoots: readonly string[]): Promise<LanguageProjectV1 | null>;
  extract(project: LanguageProjectV1): Promise<readonly LanguageFileFactsV1[]>;
  resolve(
    project: LanguageProjectV1,
    facts: readonly LanguageFileFactsV1[]
  ): Promise<LanguageResolutionV1>;
  toSourceFacts(fact: LanguageFileFactsV1): SourceFactsV1;
}
export interface DefinitionQueryV1 {
  filePath: string;
  line: number;
  character: number;
  sourceId: string;
  edgeType: 'calls' | 'references' | 'declares_resource';
}
export interface DefinitionAnswerV1 {
  query: DefinitionQueryV1;
  targetFile: string;
  targetLine: number;
  targetCharacter: number;
  producer: 'gopls' | 'pyright';
}
export interface GoImplementationEvidenceV1 {
  implementationId: string;
  interfaceId: string;
  producer: 'gopls';
  locations: readonly SourceLocationV1[];
}
