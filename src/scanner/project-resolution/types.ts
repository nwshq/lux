import type { ModuleResolutionResultV1, ProjectResolutionContextV1 } from '../contracts/program.js';

export interface ModuleResolutionRequestV1 {
  importerFile: string;
  specifier: string;
  importedName?: string;
  mode: 'import' | 'require' | 'reexport' | 'dynamic-import';
}

export interface ResolvedBindingV1 {
  request: ModuleResolutionRequestV1;
  module: ModuleResolutionResultV1;
  declarationId?: string;
}

export interface ProjectResolverV1 {
  resolve(
    request: ModuleResolutionRequestV1,
    context: ProjectResolutionContextV1
  ): ModuleResolutionResultV1;
}
