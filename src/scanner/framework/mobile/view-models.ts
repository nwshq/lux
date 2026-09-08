import type { SourceDiagnosticV1 } from '../../contracts/program.js';
import {
  binding,
  compareFacts,
  fileState,
  location,
  matchingDelimiter,
  ownerAt,
  SOURCE_EXTENSION,
  type MobileFileState,
} from './shared.js';
import type {
  MobileAnalysisInputV1,
  MobileDeclarationV1,
  MobileViewModelFactV1,
  MobileViewModelUseFactV1,
} from './types.js';

export interface MobileViewModelExtractionV1 {
  viewModels: MobileViewModelFactV1[];
  uses: MobileViewModelUseFactV1[];
  diagnostics: SourceDiagnosticV1[];
}

/**
 * Extract explicit ViewModel declarations and uses. A name is only classified when it participates
 * in direct construction/type evidence; no component-to-repository edge is inferred from suffixes.
 */
export function extractMobileViewModels(input: MobileAnalysisInputV1): MobileViewModelExtractionV1 {
  const viewModels: MobileViewModelFactV1[] = [];
  const uses: MobileViewModelUseFactV1[] = [];
  if (!input.sources || !input.extractions)
    return {
      viewModels,
      uses,
      diagnostics: [
        {
          code: 'MOBILE_INPUT_UNAVAILABLE',
          message: 'Mobile analysis requires shared source and extraction caches.',
        },
      ],
    };

  const states = [...new Set(input.files)]
    .filter((file) => SOURCE_EXTENSION.test(file))
    .sort()
    .flatMap((filePath) => {
      const source = input.sources!.get(filePath);
      const extraction = input.extractions!.get(filePath);
      return source === undefined || !extraction ? [] : [fileState(filePath, source, extraction)];
    });
  const declarations = states.flatMap((state) =>
    state.declarations
      .filter((item) => item.localName.endsWith('ViewModel'))
      .map<MobileViewModelFactV1>((item) => ({ kind: 'mobile-view-model', ...item }))
  );
  viewModels.push(...declarations);

  const hooks = extractHookReturns(states);
  for (const state of states) {
    extractDirectUses(state, uses);
    extractHookUses(state, hooks, uses);
  }
  viewModels.sort(compareFacts);
  uses.sort(compareFacts);
  return { viewModels, uses, diagnostics: [] };
}

interface HookReturn {
  declaration: MobileDeclarationV1;
  viewModelName: string;
  viewModelBinding?: ReturnType<typeof binding>;
  location: ReturnType<typeof location>;
}

function extractHookReturns(states: readonly MobileFileState[]): HookReturn[] {
  const result: HookReturn[] = [];
  for (const state of states) {
    for (const declaration of state.declarations.filter((item) =>
      /^use[A-Z0-9]/u.test(item.localName)
    )) {
      const node = state.extraction.nodes.find(
        (item) => item.type === 'function' && item.name === declaration.localName
      );
      if (!node) continue;
      const start = Buffer.from(state.source).subarray(0, node.range.startByte).toString().length;
      const end = Buffer.from(state.source).subarray(0, node.range.endByte).toString().length;
      const body = state.source.slice(start, end);
      const patterns = [
        /\breturn\s+new\s+([A-Za-z_$][\w$]*ViewModel)\s*\(/gu,
        /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*new\s+([A-Za-z_$][\w$]*ViewModel)\s*\([\s\S]*?\)[\s\S]*?\breturn\s+[A-Za-z_$][\w$]*/gu,
      ];
      for (const pattern of patterns) {
        const match = pattern.exec(body);
        if (!match) continue;
        result.push({
          declaration,
          viewModelName: match[1],
          viewModelBinding: binding(state, match[1]),
          location: location(state.filePath, state.source, start + match.index),
        });
        break;
      }
    }
  }
  return result;
}

function extractDirectUses(state: MobileFileState, result: MobileViewModelUseFactV1[]): void {
  const pattern = /\bnew\s+([A-Za-z_$][\w$]*ViewModel)\s*\(/gu;
  for (const match of state.source.matchAll(pattern)) {
    const owner = ownerAt(state, match.index);
    if (!owner || /^use[A-Z0-9]/u.test(owner.localName)) continue;
    const open = match.index + match[0].lastIndexOf('(');
    if (matchingDelimiter(state.source, open, '(', ')') < 0) continue;
    result.push({
      kind: 'mobile-view-model-use',
      filePath: state.filePath,
      owner,
      viewModelName: match[1],
      viewModelBinding: binding(state, match[1]),
      mode: 'direct',
      location: location(state.filePath, state.source, match.index),
    });
  }
}

function extractHookUses(
  state: MobileFileState,
  hooks: readonly HookReturn[],
  result: MobileViewModelUseFactV1[]
): void {
  const pattern = /\b(use[A-Z0-9][A-Za-z0-9_$]*)\s*\(/gu;
  for (const match of state.source.matchAll(pattern)) {
    const owner = ownerAt(state, match.index);
    if (!owner || owner.localName === match[1]) continue;
    const hookBinding = binding(state, match[1]);
    const candidates = hooks.filter((hook) => {
      if (hookBinding) return hook.declaration.exportName === hookBinding.importedName;
      return (
        hook.declaration.filePath === state.filePath && hook.declaration.localName === match[1]
      );
    });
    if (candidates.length !== 1) continue;
    const hook = candidates[0];
    result.push({
      kind: 'mobile-view-model-use',
      filePath: state.filePath,
      owner,
      viewModelName: hook.viewModelName,
      viewModelBinding: hook.viewModelBinding,
      mode: 'hook-return',
      hookName: match[1],
      hookBinding,
      location: location(state.filePath, state.source, match.index),
    });
  }
}
