import type { SourceDiagnosticV1 } from '../../contracts/program.js';
import {
  binding,
  compareFacts,
  fileState,
  location,
  SOURCE_EXTENSION,
  type MobileFileState,
} from './shared.js';
import type {
  MobileAnalysisInputV1,
  MobileRepositoryImplementationFactV1,
  MobileRepositoryInterfaceFactV1,
} from './types.js';

export interface MobileInterfaceExtractionV1 {
  interfaces: MobileRepositoryInterfaceFactV1[];
  implementations: MobileRepositoryImplementationFactV1[];
  diagnostics: SourceDiagnosticV1[];
}

/** Extract explicit TypeScript interface declarations and class `implements` clauses. */
export function extractMobileInterfaces(input: MobileAnalysisInputV1): MobileInterfaceExtractionV1 {
  const interfaces: MobileRepositoryInterfaceFactV1[] = [];
  const implementations: MobileRepositoryImplementationFactV1[] = [];
  if (!input.sources || !input.extractions)
    return { interfaces, implementations, diagnostics: missingInputDiagnostic() };

  for (const filePath of [...new Set(input.files)]
    .filter((file) => SOURCE_EXTENSION.test(file))
    .sort()) {
    const source = input.sources.get(filePath);
    const extraction = input.extractions.get(filePath);
    if (source === undefined || !extraction) continue;
    const state = fileState(filePath, source, extraction);
    extractDeclarations(state, interfaces);
    extractImplementations(state, implementations);
  }
  interfaces.sort(compareFacts);
  implementations.sort(compareFacts);
  return { interfaces, implementations, diagnostics: [] };
}

function extractDeclarations(
  state: MobileFileState,
  result: MobileRepositoryInterfaceFactV1[]
): void {
  const pattern = /\b(?:export\s+(?:default\s+)?)?interface\s+([A-Za-z_$][\w$]*)\b/gu;
  for (const match of state.source.matchAll(pattern)) {
    result.push({
      kind: 'mobile-repository-interface',
      filePath: state.filePath,
      localName: match[1],
      exportName: state.exports.get(match[1]) ?? match[1],
      location: location(state.filePath, state.source, match.index),
    });
  }
}

function extractImplementations(
  state: MobileFileState,
  result: MobileRepositoryImplementationFactV1[]
): void {
  const pattern = /\bclass\s+([A-Za-z_$][\w$]*)[^{;]*?\bimplements\s+([^{}]+)\x7b/gu;
  for (const match of state.source.matchAll(pattern)) {
    const declaration = state.declarations.find((item) => item.localName === match[1]);
    if (!declaration) continue;
    for (const item of match[2].split(',')) {
      const typeMatch = /^\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*$/u.exec(item);
      if (!typeMatch) continue;
      const name = typeMatch[1];
      const relative = match[0].indexOf(name);
      result.push({
        kind: 'mobile-repository-implementation',
        ...declaration,
        interfaceName: name,
        interfaceBinding: binding(state, name),
        interfaceLocation: location(state.filePath, state.source, match.index + relative),
      });
    }
  }
}

function missingInputDiagnostic(): SourceDiagnosticV1[] {
  return [
    {
      code: 'MOBILE_INPUT_UNAVAILABLE',
      message: 'Mobile analysis requires shared source and extraction caches.',
    },
  ];
}
