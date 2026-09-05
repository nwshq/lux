import type {
  DeclarationFactV1,
  ReferenceFactV1,
  SourceFactsV1,
  SourceLocationV1,
} from '../contracts/program.js';
import {
  astLanguageId,
  type AstEdge,
  type AstLang,
  type AstNode,
  type AstRange,
  type Extraction,
  type ModuleSyntaxFact,
} from './extract.js';

function location(filePath: string, range: AstRange): SourceLocationV1 {
  return { filePath, line: range.startLine, column: range.startColumn };
}

function declarationLocalId(node: AstNode): string {
  return node.type === 'method' && node.container ? `${node.container}.${node.name}` : node.name;
}

function enclosingDeclaration(nodes: readonly AstNode[], byte: number): string {
  let winner: AstNode | undefined;
  for (const node of nodes) {
    if (node.range.startByte <= byte && byte < node.range.endByte) {
      if (
        !winner ||
        node.range.endByte - node.range.startByte < winner.range.endByte - winner.range.startByte
      ) {
        winner = node;
      }
    }
  }
  return winner ? declarationLocalId(winner) : `file:${nodes[0]?.file ?? ''}`;
}

function moduleReference(filePath: string, fact: ModuleSyntaxFact): ReferenceFactV1 {
  const isImport = fact.kind === 'esm-import' || fact.kind === 'commonjs-require';
  return {
    fromLocalId: `file:${filePath}`,
    kind: isImport ? 'import' : 'export',
    rawTarget: fact.specifier ?? fact.exportedName ?? fact.localName ?? '',
    ...(fact.importedName ? { member: fact.importedName } : {}),
    location: location(filePath, fact.range),
  };
}

function callReference(
  filePath: string,
  nodes: readonly AstNode[],
  edge: AstEdge
): ReferenceFactV1 | undefined {
  if (edge.type === 'import') return undefined;
  return {
    fromLocalId: enclosingDeclaration(nodes, edge.range.startByte),
    kind: edge.type === 'call' ? 'call' : 'reference',
    rawTarget: edge.toRaw,
    ...(edge.member ? { member: edge.member } : {}),
    location: location(filePath, edge.nameRange ?? edge.range),
  };
}

export function extractionToSourceFacts(
  filePath: string,
  lang: AstLang,
  extraction: Extraction
): SourceFactsV1 {
  const declarations: DeclarationFactV1[] = extraction.nodes.map((node) => ({
    localId: declarationLocalId(node),
    kind: node.type,
    name: node.name,
    ...(node.container ? { container: node.container } : {}),
    location: location(filePath, node.range),
  }));
  const callReferences = extraction.edges
    .map((edge) => callReference(filePath, extraction.nodes, edge))
    .filter((fact): fact is ReferenceFactV1 => fact !== undefined);

  return {
    schemaVersion: 1,
    languageId: astLanguageId(lang),
    filePath,
    declarations,
    references: [
      ...(extraction.moduleFacts ?? []).map((fact) => moduleReference(filePath, fact)),
      ...callReferences,
    ],
    diagnostics: (extraction.diagnostics ?? []).map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.range ? { location: location(filePath, diagnostic.range) } : {}),
    })),
  };
}
