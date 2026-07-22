// AST structural association resolver (Phase 3 of the arm-D tier).
//
// Emits the `calls` / `references` structural edges that the EdgeType union
// declares but no resolver produced until now. Two classes of edge are resolved
// here, both from syntax alone (no LSP):
//
//   - same-file  — a call/new to a definition in the SAME file, attributed to
//                  the enclosing symbol by range containment.
//   - import-bound cross-file — a call/new whose callee is a directly-imported
//                  name; the module is resolved to a scanned file (TS) or the
//                  FQN is matched (PHP), and the edge points at that symbol.
//
// Typed-receiver calls (`db.method()`) still need the LSP-resolve step and are
// intentionally left for that increment. All edges here are `framework-inferred`
// confidence: syntactic resolution is deterministic, and the engine drops
// uncorroborated `heuristic` edges from storage entirely.

import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../associations/types.js';
import { phpSymbolNodeId, tsSymbolNodeId } from '../associations/types.js';
import {
  langForFile,
  getGrammars,
  extractSource,
  type AstLang,
  type Extraction,
  type ImportBinding,
} from './extract.js';
import { astSymbolIdentity } from './symbols.js';

/** Confidence assigned to AST-only (syntactic) edges. */
const AST_CONFIDENCE = 0.6;

interface FileExtraction {
  relPath: string;
  lang: AstLang;
  extraction: Extraction;
}

export class AstStructuralResolver implements AssociationResolver {
  readonly name = 'ast-structural';

  /**
   * Scoped-refresh only (Decision 13): verify a cross-file target against the persisted node
   * universe when it is absent from the in-memory (R-only) symbol set. Undefined ⇒ full-rebuild
   * behavior — the in-memory universe IS the whole scan, so no DB fallback is needed.
   */
  constructor(private readonly options: { verifyExternalTarget?: (id: string) => boolean } = {}) {}

  supports(context: AssociationContext): boolean {
    return context.entries.some(
      (e) => langForFile(e.filePath) !== null && typeof e.metadata?.content === 'string'
    );
  }

  async resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    const now = Math.floor(Date.now() / 1000);
    const eligible = context.entries.filter(
      (e) => langForFile(e.filePath) !== null && typeof e.metadata?.content === 'string'
    );
    if (eligible.length === 0) return [];

    // Read from the shared per-rebuild extraction cache when present (Lever D);
    // only load grammars when we have to parse ourselves.
    const shared = context.sharedExtractions;
    const grammars = shared ? null : await getGrammars();

    // Pass 1: extract every file; build the symbol universe + scanned-file set.
    const files: FileExtraction[] = [];
    const symbolIds = new Set<string>();
    const relPaths = new Set<string>();
    for (const entry of eligible) {
      const lang = langForFile(entry.filePath);
      if (!lang) continue;
      const relPath = toRelative(entry.filePath, context.rootPath);
      let extraction: Extraction;
      if (shared) {
        const cached = shared.get(relPath);
        if (!cached) continue; // absent from the shared cache — isolated upstream
        extraction = cached;
      } else {
        extraction = extractSource(
          grammars!,
          entry.metadata?.content as string,
          relPath,
          lang
        ).extraction;
      }
      files.push({ relPath, lang, extraction });
      relPaths.add(relPath);
      for (const def of extraction.nodes) {
        symbolIds.add(astSymbolIdentity(relPath, def, lang, extraction.namespace).id);
      }
    }

    // Pass 2: emit edges (targets are verified against the symbol universe).
    const edges: StructuralRelationEdge[] = [];
    for (const f of files) {
      edges.push(...sameFileEdges(f, this.name, now));
      edges.push(
        ...crossFileEdges(f, relPaths, symbolIds, this.name, now, this.options.verifyExternalTarget)
      );
    }
    return edges;
  }
}

// ---------------------------------------------------------------------------
// Edge derivation
// ---------------------------------------------------------------------------

interface DefEntry {
  name: string;
  id: string;
  kind: 'function' | 'method' | 'class';
  container?: string;
  startByte: number;
  endByte: number;
}

function defEntries(f: FileExtraction): DefEntry[] {
  return f.extraction.nodes.map((def) => ({
    name: def.name,
    id: astSymbolIdentity(f.relPath, def, f.lang, f.extraction.namespace).id,
    kind: def.type,
    container: def.container,
    startByte: def.range.startByte,
    endByte: def.range.endByte,
  }));
}

function sameFileEdges(f: FileExtraction, resolver: string, now: number): StructuralRelationEdge[] {
  const languageId = f.lang === 'php' ? 'php' : 'typescript';
  const defs = defEntries(f);

  // Bare calls / constructions target a same-file function or class (first
  // definition of a name wins; overloads collapse). Methods are excluded — a
  // bare identifier can never name a method.
  const fnClassByName = new Map<string, string>();
  for (const d of defs) {
    if ((d.kind === 'function' || d.kind === 'class') && !fnClassByName.has(d.name)) {
      fnClassByName.set(d.name, d.id);
    }
  }
  // `this`-calls target a method of the SAME class as the call site — indexed by
  // container so `this.foo()` can't resolve to a sibling class's `foo`.
  const methodByContainer = new Map<string, Map<string, string>>();
  for (const d of defs) {
    if (d.kind === 'method' && d.container) {
      let byName = methodByContainer.get(d.container);
      if (!byName) {
        byName = new Map();
        methodByContainer.set(d.container, byName);
      }
      if (!byName.has(d.name)) byName.set(d.name, d.id);
    }
  }

  const edges: StructuralRelationEdge[] = [];
  const seen = new Set<string>();

  for (const edge of f.extraction.edges) {
    if (edge.type !== 'call' && edge.type !== 'new') continue;

    const source = enclosingDef(defs, edge.range.startByte);
    if (!source) continue;

    let targetId: string | undefined;
    if (edge.type === 'new') {
      if (!edge.resolvedSameFile) continue;
      targetId = fnClassByName.get(edge.toRaw);
    } else if (edge.callKind === 'identifier') {
      if (!edge.resolvedSameFile) continue; // import-bound handled in crossFileEdges
      targetId = fnClassByName.get(edge.member ?? edge.toRaw);
    } else if (edge.callKind === 'this') {
      if (!source.container) continue; // `this` outside a method — nothing to bind
      targetId = methodByContainer.get(source.container)?.get(edge.member ?? '');
    } else {
      continue; // `member` (typed receiver) — left for the LSP-resolve tier
    }
    if (!targetId || source.id === targetId) continue;

    const edgeType = edge.type === 'new' ? 'references' : 'calls';
    const id = `${source.id}→${targetId}:${edgeType}:ast`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push(
      makeEdge(
        id,
        edgeType,
        source.id,
        targetId,
        languageId,
        languageId,
        resolver,
        `ast-same-file-${edge.type}`,
        f.relPath,
        edge.range.startLine,
        now
      )
    );
  }

  return edges;
}

function crossFileEdges(
  f: FileExtraction,
  relPaths: Set<string>,
  symbolIds: Set<string>,
  resolver: string,
  now: number,
  verifyExternalTarget?: (id: string) => boolean
): StructuralRelationEdge[] {
  const imports = f.extraction.imports ?? [];
  if (imports.length === 0) return [];
  const languageId = f.lang === 'php' ? 'php' : 'typescript';

  const importMap = new Map<string, ImportBinding>();
  for (const imp of imports) if (!importMap.has(imp.local)) importMap.set(imp.local, imp);

  const defs = defEntries(f);
  const edges: StructuralRelationEdge[] = [];
  const seen = new Set<string>();

  for (const edge of f.extraction.edges) {
    if (edge.type !== 'call' && edge.type !== 'new') continue;
    if (edge.resolvedSameFile) continue; // same-file handled elsewhere
    // Only bare calls and constructions bind to an imported name; member/`this`
    // calls reference a receiver, not the import itself (those go to the LSP tier).
    if (edge.type === 'call' && edge.callKind !== 'identifier') continue;

    const localName = edge.type === 'new' ? edge.toRaw : (edge.member ?? edge.toRaw);
    const binding = importMap.get(localName);
    if (!binding) continue;

    const targetId = resolveImportTarget(binding, f.relPath, f.lang, relPaths);
    if (!targetId) continue;
    // In-memory universe first (co-changed targets in R), then the persisted universe for
    // targets OUTSIDE R (Decision 13). Full rebuild passes no verifier ⇒ in-memory only.
    if (!symbolIds.has(targetId) && !(verifyExternalTarget?.(targetId) ?? false)) continue;

    const source = enclosingDef(defs, edge.range.startByte);
    if (!source || source.id === targetId) continue;

    const edgeType = edge.type === 'new' ? 'references' : 'calls';
    const id = `${source.id}→${targetId}:${edgeType}:ast-xf`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push(
      makeEdge(
        id,
        edgeType,
        source.id,
        targetId,
        languageId,
        languageId,
        resolver,
        `ast-import-bound-${edge.type}`,
        f.relPath,
        edge.range.startLine,
        now
      )
    );
  }

  return edges;
}

/** Resolve an imported binding to a target symbol node id (or undefined). */
function resolveImportTarget(
  binding: ImportBinding,
  fromRel: string,
  lang: AstLang,
  relPaths: Set<string>
): string | undefined {
  if (lang === 'php') {
    // PHP `use` gives the FQN directly (e.g. `new Money()` -> the class node).
    return phpSymbolNodeId(binding.imported);
  }
  // TS/TSX: resolve the relative module to a scanned file, then the named export.
  if (binding.imported === 'default' || !binding.module) return undefined;
  const targetFile = resolveTsModule(binding.module, fromRel, relPaths);
  if (!targetFile) return undefined;
  return tsSymbolNodeId(targetFile, binding.imported);
}

/** Resolve a relative TS/JS module specifier to a scanned file's relative path. */
function resolveTsModule(
  module: string,
  fromRel: string,
  relPaths: Set<string>
): string | undefined {
  if (!module.startsWith('.')) return undefined; // relative imports only
  const baseDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const joined = normalizeRel(baseDir, module);
  const stripped = joined.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const candidates = [
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}/index.ts`,
    `${stripped}/index.tsx`,
  ];
  if (joined.endsWith('.ts') || joined.endsWith('.tsx')) candidates.unshift(joined);
  return candidates.find((c) => relPaths.has(c));
}

function normalizeRel(baseDir: string, spec: string): string {
  const parts = baseDir ? baseDir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Innermost definition whose byte span contains `byte`, or undefined. */
function enclosingDef(defs: DefEntry[], byte: number): DefEntry | undefined {
  let best: DefEntry | undefined;
  let bestSize = Infinity;
  for (const d of defs) {
    if (d.startByte <= byte && byte < d.endByte) {
      const size = d.endByte - d.startByte;
      if (size < bestSize) {
        best = d;
        bestSize = size;
      }
    }
  }
  return best;
}

function makeEdge(
  id: string,
  edgeType: 'calls' | 'references',
  sourceNodeId: string,
  targetNodeId: string,
  sourceLanguage: string,
  targetLanguage: string,
  resolver: string,
  evidenceKind: string,
  filePath: string,
  line: number,
  now: number
): StructuralRelationEdge {
  return {
    id,
    edgeType,
    sourceNodeId,
    targetNodeId,
    sourceLanguage,
    targetLanguage,
    confidence: AST_CONFIDENCE,
    confidenceClass: 'framework-inferred',
    provenance: {
      resolver,
      evidenceKind,
      evidenceLocations: [{ filePath, line, note: targetNodeId }],
      extractedAt: now,
    },
  };
}

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}
