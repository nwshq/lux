import type { SourceDiagnosticV1, SourceLocationV1 } from '../../contracts/program.js';
import type { AstNode, Extraction } from '../../ast/extract.js';
import type { NavigationComponentV1 } from './types.js';

export const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;

export function location(filePath: string, source: string, offset: number): SourceLocationV1 {
  const before = source.slice(0, Math.max(0, offset));
  const lines = before.split('\n');
  return { filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function byteOffset(source: string, byte: number): number {
  return Buffer.from(source).subarray(0, byte).toString().length;
}

export function componentAt(
  source: string,
  extraction: Extraction,
  components: readonly NavigationComponentV1[],
  offset: number
): NavigationComponentV1 | undefined {
  const candidates = extraction.nodes
    .filter(
      (node) =>
        (node.type === 'function' || node.type === 'class') &&
        byteOffset(source, node.range.startByte) <= offset &&
        offset <= byteOffset(source, node.range.endByte)
    )
    .sort((left, right) => rangeSize(left) - rangeSize(right));
  for (const node of candidates) {
    const component = components.find((item) => item.localName === node.name);
    if (component) return component;
  }
  return undefined;
}

function rangeSize(node: AstNode): number {
  return node.range.endByte - node.range.startByte;
}

/** Return the argument text and end offset for a call whose opening parenthesis is known. */
export function callArguments(
  source: string,
  open: number
): { text: string; end: number } | undefined {
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
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth++;
    else if (character === ')' && --depth === 0)
      return { text: source.slice(open + 1, index), end: index + 1 };
  }
  return undefined;
}

export function firstArgument(argumentsText: string): string {
  let quote = '';
  let escaped = false;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let index = 0; index < argumentsText.length; index++) {
    const character = argumentsText[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '{') braces++;
    else if (character === '}') braces--;
    else if (character === '[') brackets++;
    else if (character === ']') brackets--;
    else if (character === '(') parentheses++;
    else if (character === ')') parentheses--;
    else if (character === ',' && braces === 0 && brackets === 0 && parentheses === 0)
      return argumentsText.slice(0, index).trim();
  }
  return argumentsText.trim();
}

export function literal(value: string): string | undefined {
  const match = /^\s*(['"])([^'"]+)\1\s*$/u.exec(value);
  return match?.[2];
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
