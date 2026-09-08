import type { SourceDiagnosticV1, SourceLocationV1 } from '../../contracts/program.js';
import type { ImportBinding, Extraction } from '../../ast/extract.js';
import type { MobileBindingV1, MobileDeclarationV1 } from './types.js';

export const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;

export interface MobileFileState {
  filePath: string;
  source: string;
  extraction: Extraction;
  imports: ReadonlyMap<string, ImportBinding>;
  exports: ReadonlyMap<string, string>;
  declarations: MobileDeclarationV1[];
}

export function fileState(
  filePath: string,
  source: string,
  extraction: Extraction
): MobileFileState {
  const exports = new Map<string, string>();
  for (const fact of extraction.moduleFacts ?? []) {
    if (fact.kind === 'esm-export-default' && fact.localName)
      exports.set(fact.localName, 'default');
    else if (fact.kind === 'esm-export-named' && fact.localName && fact.exportedName)
      exports.set(fact.localName, fact.exportedName);
    else if (
      (fact.kind === 'commonjs-module-exports' || fact.kind === 'commonjs-exports-member') &&
      fact.localName
    )
      exports.set(fact.localName, fact.exportedName ?? 'default');
  }
  const declarations = extraction.nodes
    .filter((node) => node.type === 'function' || node.type === 'class')
    .map((node) => ({
      filePath,
      localName: node.name,
      exportName: exports.get(node.name) ?? node.name,
      location: location(filePath, source, byteOffset(source, node.range.startByte)),
    }));
  return {
    filePath,
    source,
    extraction,
    imports: new Map((extraction.imports ?? []).map((item) => [item.local, item])),
    exports,
    declarations,
  };
}

export function binding(state: MobileFileState, localName: string): MobileBindingV1 | undefined {
  const value = state.imports.get(localName);
  if (!value?.module) return undefined;
  return {
    localName,
    importedName: value.imported,
    sourceSpecifier: value.module,
  };
}

export function location(filePath: string, source: string, offset: number): SourceLocationV1 {
  const lines = source.slice(0, Math.max(0, offset)).split('\n');
  return { filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function byteOffset(source: string, byte: number): number {
  return Buffer.from(source).subarray(0, byte).toString().length;
}

export function ownerAt(state: MobileFileState, offset: number): MobileDeclarationV1 | undefined {
  const containing = state.extraction.nodes
    .filter(
      (node) =>
        (node.type === 'function' || node.type === 'class' || node.type === 'method') &&
        byteOffset(state.source, node.range.startByte) <= offset &&
        offset <= byteOffset(state.source, node.range.endByte)
    )
    .sort(
      (left, right) =>
        left.range.endByte - left.range.startByte - (right.range.endByte - right.range.startByte)
    );
  for (const node of containing) {
    const localName = node.container ?? node.name;
    const found = state.declarations.find((item) => item.localName === localName);
    if (found) return found;
  }
  return undefined;
}

export function splitArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '(' || character === '[' || character === '{' || character === '<')
      depth++;
    else if (character === ')' || character === ']' || character === '}' || character === '>')
      depth--;
    else if (character === ',' && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

export function matchingDelimiter(
  source: string,
  open: number,
  opening: string,
  closing: string
): number {
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === opening) depth++;
    else if (character === closing && --depth === 0) return index;
  }
  return -1;
}

export function compareFacts(
  left: { kind: string; filePath: string; location?: SourceLocationV1 },
  right: { kind: string; filePath: string; location?: SourceLocationV1 }
): number {
  return [left.filePath, left.location?.line ?? 0, left.location?.column ?? 0, left.kind]
    .join('\0')
    .localeCompare(
      [right.filePath, right.location?.line ?? 0, right.location?.column ?? 0, right.kind].join(
        '\0'
      )
    );
}

export function sortDiagnostics(values: SourceDiagnosticV1[]): SourceDiagnosticV1[] {
  return values.sort((left, right) =>
    [left.location?.filePath ?? '', left.location?.line ?? 0, left.location?.column ?? 0, left.code]
      .join('\0')
      .localeCompare(
        [
          right.location?.filePath ?? '',
          right.location?.line ?? 0,
          right.location?.column ?? 0,
          right.code,
        ].join('\0')
      )
  );
}
