import type Parser from 'web-tree-sitter';
import type { SourceRangeV1 } from '../infrastructure-types.js';
export function hclRange(filePath: string, node: Parser.SyntaxNode): SourceRangeV1 {
  return {
    filePath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}
export function hclString(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node || node.type !== 'string_lit') return undefined;
  const text = node.text;
  if (!/^"[\s\S]*"$/u.test(text) || text.includes('${')) return undefined;
  return text.slice(1, -1);
}
