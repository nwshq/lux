import type { SourceDiagnosticV1 } from '../../contracts/program.js';
import {
  binding,
  compareFacts,
  fileState,
  location,
  matchingDelimiter,
  ownerAt,
  SOURCE_EXTENSION,
  splitArguments,
  type MobileFileState,
} from './shared.js';
import type {
  MobileAnalysisInputV1,
  MobileConstructionFactV1,
  MobileConstructorDependencyFactV1,
} from './types.js';

export interface MobileConstructorExtractionV1 {
  constructions: MobileConstructionFactV1[];
  dependencies: MobileConstructorDependencyFactV1[];
  diagnostics: SourceDiagnosticV1[];
}

/** Extract constructor calls and statically named constructor parameter types. */
export function extractMobileConstructors(
  input: MobileAnalysisInputV1
): MobileConstructorExtractionV1 {
  const constructions: MobileConstructionFactV1[] = [];
  const dependencies: MobileConstructorDependencyFactV1[] = [];
  if (!input.sources || !input.extractions)
    return {
      constructions,
      dependencies,
      diagnostics: [
        {
          code: 'MOBILE_INPUT_UNAVAILABLE',
          message: 'Mobile analysis requires shared source and extraction caches.',
        },
      ],
    };

  for (const filePath of [...new Set(input.files)]
    .filter((file) => SOURCE_EXTENSION.test(file))
    .sort()) {
    const source = input.sources.get(filePath);
    const extraction = input.extractions.get(filePath);
    if (source === undefined || !extraction) continue;
    const state = fileState(filePath, source, extraction);
    extractConstructions(state, constructions);
    extractDependencies(state, dependencies);
  }
  constructions.sort(compareFacts);
  dependencies.sort(compareFacts);
  return { constructions, dependencies, diagnostics: [] };
}

function extractConstructions(state: MobileFileState, result: MobileConstructionFactV1[]): void {
  const pattern = /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/gu;
  for (const match of state.source.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = matchingDelimiter(state.source, open, '(', ')');
    if (close < 0) continue;
    const prefix = state.source.slice(Math.max(0, match.index - 100), match.index);
    const assigned = /(?:\b(?:const|let|var)\s+|\bthis\.)([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(prefix);
    result.push({
      kind: 'mobile-construction',
      filePath: state.filePath,
      owner: ownerAt(state, match.index),
      ...(assigned ? { assignedName: assigned[1] } : {}),
      constructedName: match[1],
      constructedBinding: binding(state, match[1]),
      arguments: splitArguments(state.source.slice(open + 1, close)),
      location: location(state.filePath, state.source, match.index),
    });
  }
}

function extractDependencies(
  state: MobileFileState,
  result: MobileConstructorDependencyFactV1[]
): void {
  const constructorPattern = /\bconstructor\s*\(/gu;
  for (const classDeclaration of state.declarations) {
    const astClass = state.extraction.nodes.find(
      (node) => node.type === 'class' && node.name === classDeclaration.localName
    );
    if (!astClass) continue;
    const start = Buffer.from(state.source).subarray(0, astClass.range.startByte).toString().length;
    const end = Buffer.from(state.source).subarray(0, astClass.range.endByte).toString().length;
    const classSource = state.source.slice(start, end);
    const constructor = constructorPattern.exec(classSource);
    constructorPattern.lastIndex = 0;
    if (!constructor) continue;
    const open = start + constructor.index + constructor[0].lastIndexOf('(');
    const close = matchingDelimiter(state.source, open, '(', ')');
    if (close < 0 || close > end) continue;
    for (const parameter of splitArguments(state.source.slice(open + 1, close))) {
      const match =
        /^(?:\s*(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\??\s*:\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:=.*)?$/u.exec(
          parameter
        );
      if (!match) continue;
      const parameterOffset = state.source.indexOf(parameter, open + 1);
      result.push({
        kind: 'mobile-constructor-dependency',
        ...classDeclaration,
        parameterName: match[1],
        dependencyName: match[2],
        dependencyBinding: binding(state, match[2]),
        dependencyLocation: location(
          state.filePath,
          state.source,
          parameterOffset + parameter.indexOf(match[2])
        ),
      });
    }
  }
}
