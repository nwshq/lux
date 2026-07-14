// Typed-receiver cross-file resolution via LSP (Step 2 of cross-file resolution).
//
// Resolves the call edges AST cannot settle syntactically — `db.method()` /
// `$service->method()`, where the callee's owner is a typed value whose type
// only LSP knows. Each such callee token is resolved with `textDocument/definition`
// (deduped per distinct `receiver.method` to bound request volume — the arm-D
// efficiency), and the target location is mapped back to a symbol node via the
// same extractions.
//
// These are the AST tier's only `proven` edges — they are LSP-confirmed. Runs as
// a dedicated pass while the LSP registry is still alive (see general.ts).

import type { StructuralRelationEdge } from '../associations/types.js';
import {
  extractSource,
  getGrammars,
  langForFile,
  type AstLang,
  type Extraction,
} from './extract.js';
import { astSymbolIdentity } from './symbols.js';

/** On-demand definition resolver: (absFile, 0-based line, 0-based char) -> target. */
export type ResolveDefinition = (
  filePath: string,
  line: number,
  character: number
) => Promise<{ filePath: string; line: number } | null>;

/** Confidence for LSP-confirmed cross-file edges. */
const LSP_CONFIDENCE = 0.9;

interface FileRec {
  relPath: string;
  absPath: string;
  lang: AstLang;
  extraction: Extraction;
}

interface DefRange {
  id: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
}

/**
 * Resolve typed-receiver cross-file calls to `proven` `calls` edges via LSP.
 *
 * @param entries - Source files with their content (absolute paths).
 * @param resolveDefinition - On-demand LSP definition resolver.
 */
export async function resolveTypedReceiverEdges(
  entries: Array<{ filePath: string; content: string }>,
  rootPath: string,
  resolveDefinition: ResolveDefinition,
  now: number
): Promise<StructuralRelationEdge[]> {
  const grammars = await getGrammars();

  const files: FileRec[] = [];
  const symbolIds = new Set<string>();
  const defRangesByRel = new Map<string, DefRange[]>();

  for (const entry of entries) {
    const lang = langForFile(entry.filePath);
    if (!lang) continue;
    const relPath = toRelative(entry.filePath, rootPath);
    const { extraction } = extractSource(grammars, entry.content, relPath, lang);
    files.push({ relPath, absPath: entry.filePath, lang, extraction });
    const ranges = extraction.nodes.map((def) => ({
      id: astSymbolIdentity(relPath, def, lang, extraction.namespace).id,
      startByte: def.range.startByte,
      endByte: def.range.endByte,
      startLine: def.range.startLine,
      endLine: def.range.endLine,
    }));
    defRangesByRel.set(relPath, ranges);
    for (const r of ranges) symbolIds.add(r.id);
  }

  const edges: StructuralRelationEdge[] = [];
  const seenEdge = new Set<string>();
  const targetCache = new Map<string, string | null>(); // `${source.id}::${toRaw}` -> targetId|null

  for (const f of files) {
    const defs = defRangesByRel.get(f.relPath) ?? [];
    const langId = f.lang === 'php' ? 'php' : 'typescript';

    for (const edge of f.extraction.edges) {
      // Only typed-receiver member calls (`obj.m()` / `$svc->m()`) reach LSP;
      // identifier and `this` calls are settled syntactically by the AST resolver
      // (import-bound / same-class), so routing them here would double-resolve.
      if (edge.type !== 'call' || edge.callKind !== 'member' || !edge.nameRange) continue;

      const source = enclosingByByte(defs, edge.range.startByte);
      if (!source) continue;

      // Cache per (enclosing scope + receiver expression). Two identical receiver
      // expressions in the SAME function share a binding; the same text in a
      // different function can be a different-typed value, so it must NOT reuse
      // the earlier result (keying on relPath+text alone collapsed those).
      const cacheKey = `${source.id}::${edge.toRaw}`;
      let targetId = targetCache.get(cacheKey);
      if (targetId === undefined) {
        targetId = await resolveOne(
          edge.nameRange,
          f.absPath,
          rootPath,
          defRangesByRel,
          symbolIds,
          resolveDefinition
        );
        targetCache.set(cacheKey, targetId);
      }
      if (!targetId || targetId === source.id) continue;

      const id = `${source.id}→${targetId}:calls:lsp`;
      if (seenEdge.has(id)) continue;
      seenEdge.add(id);
      edges.push({
        id,
        edgeType: 'calls',
        sourceNodeId: source.id,
        targetNodeId: targetId,
        sourceLanguage: langId,
        targetLanguage: langId,
        confidence: LSP_CONFIDENCE,
        confidenceClass: 'proven',
        provenance: {
          resolver: 'ast-structural',
          evidenceKind: 'ast-lsp-typed-receiver',
          evidenceLocations: [
            { filePath: f.relPath, line: edge.range.startLine, note: edge.toRaw },
          ],
          extractedAt: now,
        },
      });
    }
  }

  return edges;
}

async function resolveOne(
  nameRange: { startLine: number; startColumn: number },
  absPath: string,
  rootPath: string,
  defRangesByRel: Map<string, DefRange[]>,
  symbolIds: Set<string>,
  resolveDefinition: ResolveDefinition
): Promise<string | null> {
  const loc = await resolveDefinition(absPath, nameRange.startLine - 1, nameRange.startColumn);
  if (!loc) return null;
  const targetRel = toRelative(loc.filePath, rootPath);
  const trDefs = defRangesByRel.get(targetRel);
  if (!trDefs) return null; // target outside the scanned corpus (vendor / node_modules)
  const def = enclosingByLine(trDefs, loc.line + 1);
  return def && symbolIds.has(def.id) ? def.id : null;
}

function enclosingByByte(defs: DefRange[], byte: number): DefRange | undefined {
  let best: DefRange | undefined;
  let bestSize = Infinity;
  for (const d of defs) {
    if (d.startByte <= byte && byte < d.endByte && d.endByte - d.startByte < bestSize) {
      best = d;
      bestSize = d.endByte - d.startByte;
    }
  }
  return best;
}

function enclosingByLine(defs: DefRange[], line: number): DefRange | undefined {
  // Among defs whose line span contains the target, pick the smallest by BYTE
  // span. Byte span (not line span) is what separates a method from its class
  // when both sit on the same line (`class A { run() {} }`), where a line-span
  // tie would otherwise pick the outer class.
  let best: DefRange | undefined;
  let bestSize = Infinity;
  for (const d of defs) {
    if (d.startLine <= line && line <= d.endLine) {
      const size = d.endByte - d.startByte;
      if (size < bestSize) {
        best = d;
        bestSize = size;
      }
    }
  }
  return best;
}

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}
