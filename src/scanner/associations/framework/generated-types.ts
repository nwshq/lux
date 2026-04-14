// Generated types resolver.
//
// Detects artifact-backed bridges between backend schemas/DTOs and
// generated TypeScript declarations consumed by the frontend.
//
// Bridges detected in this round:
//   - backend schema → generated TS declaration bundle  (uses_generated_type)
//   - manifest-backed client usage → generated artifact  (uses_generated_type)

import type { AssociationContext, AssociationResolver, StructuralRelationEdge } from '../types.js';
import { fileNodeId, artifactNodeId } from '../types.js';

// ---------------------------------------------------------------------------
// Common generated artifact filename patterns
// ---------------------------------------------------------------------------

/** Filenames that typically indicate generated TypeScript declaration bundles. */
const GENERATED_TS_PATTERNS = [
  /\.d\.ts$/,
  /generated\./i,
  /auto-generated\./i,
  /openapi-types\./i,
  /api-types\./i,
  /ziggy\.js$/i,  // Laravel Ziggy route types
];

/** PHP file patterns that typically produce type artifacts. */
const PHP_DTO_PATTERNS = [
  /Data\.php$/,      // Laravel Spatie Data DTOs
  /Resource\.php$/,  // Laravel API resources
  /Request\.php$/,   // Laravel form requests
];

// ---------------------------------------------------------------------------
// GeneratedTypesResolver
// ---------------------------------------------------------------------------

export class GeneratedTypesResolver implements AssociationResolver {
  readonly name = 'generated-types';

  supports(context: AssociationContext): boolean {
    const hasPhp = context.entries.some((e) => e.languageId === 'php');
    const hasTs = context.entries.some(
      (e) => e.languageId === 'typescript' || e.languageId === 'javascript'
    );
    return hasPhp && hasTs;
  }

  async resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    const edges: StructuralRelationEdge[] = [];
    const now = Math.floor(Date.now() / 1000);

    // 1. Find generated TS declaration files
    const generatedArtifacts = findGeneratedArtifacts(context);

    if (generatedArtifacts.length === 0) return edges;

    // 2. Find PHP DTOs/resources that likely produced those artifacts
    const phpSources = findPhpTypeSources(context);

    // 3. Match PHP sources to generated artifacts via naming convention
    for (const phpSource of phpSources) {
      const matched = findMatchingArtifact(phpSource.baseName, generatedArtifacts);
      if (!matched) continue;

      const edgeId = `${phpSource.fileId}→${matched.artifactId}:uses_generated_type`;
      edges.push({
        id: edgeId,
        edgeType: 'uses_generated_type',
        sourceNodeId: phpSource.fileId,
        targetNodeId: matched.artifactId,
        sourceLanguage: 'php',
        targetLanguage: 'typescript',
        confidence: matched.confidence,
        confidenceClass: 'artifact-backed',
        provenance: {
          resolver: this.name,
          evidenceKind: 'schema-to-generated-artifact',
          evidenceLocations: [
            { filePath: phpSource.filePath, note: 'PHP source type' },
            { filePath: matched.filePath, note: 'generated artifact' },
          ],
          extractedAt: now,
        },
      });
    }

    // 4. Find TS files that import from generated artifacts
    const tsImporters = findTsImportersOfArtifacts(context, generatedArtifacts);

    for (const importer of tsImporters) {
      const edgeId = `${importer.fileId}→${importer.artifactId}:uses_generated_type`;
      edges.push({
        id: edgeId,
        edgeType: 'uses_generated_type',
        sourceNodeId: importer.fileId,
        targetNodeId: importer.artifactId,
        sourceLanguage: importer.language,
        targetLanguage: 'typescript',
        confidence: 0.95,
        confidenceClass: 'artifact-backed',
        provenance: {
          resolver: this.name,
          evidenceKind: 'ts-import-of-generated-artifact',
          evidenceLocations: [
            { filePath: importer.filePath, line: importer.line, note: importer.importPath },
          ],
          extractedAt: now,
        },
      });
    }

    return edges;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GeneratedArtifact {
  artifactId: string;
  filePath: string;
  baseName: string;
  confidence: number;
}

interface PhpTypeSource {
  fileId: string;
  filePath: string;
  baseName: string;
}

interface TsImporter {
  fileId: string;
  filePath: string;
  language: string;
  artifactId: string;
  importPath: string;
  line: number;
}

function findGeneratedArtifacts(context: AssociationContext): GeneratedArtifact[] {
  return context.entries
    .filter((e) => {
      const fp = e.filePath.toLowerCase();
      return GENERATED_TS_PATTERNS.some((p) => p.test(fp));
    })
    .map((e) => {
      const rel = toRelative(e.filePath, context.rootPath);
      const baseName = rel.split('/').pop()?.replace(/\.[^.]+$/, '') ?? rel;
      return {
        artifactId: artifactNodeId(rel),
        filePath: e.filePath,
        baseName: baseName.toLowerCase(),
        confidence: 0.9,
      };
    });
}

function findPhpTypeSources(context: AssociationContext): PhpTypeSource[] {
  return context.entries
    .filter((e) => {
      const fp = e.filePath;
      return e.languageId === 'php' && PHP_DTO_PATTERNS.some((p) => p.test(fp));
    })
    .map((e) => {
      const rel = toRelative(e.filePath, context.rootPath);
      const baseName =
        rel
          .split('/')
          .pop()
          ?.replace(/\.php$/, '')
          .toLowerCase() ?? rel;
      return {
        fileId: fileNodeId(rel),
        filePath: e.filePath,
        baseName,
      };
    });
}

function findMatchingArtifact(
  phpBaseName: string,
  artifacts: GeneratedArtifact[]
): GeneratedArtifact | null {
  // Direct name match (e.g. InvoiceData → invoice-data or InvoiceData.d.ts)
  const normalized = phpBaseName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');

  const match =
    artifacts.find((a) => a.baseName === phpBaseName) ??
    artifacts.find((a) => a.baseName === normalized) ??
    artifacts.find((a) => a.baseName.includes(phpBaseName));

  return match ?? null;
}

function findTsImportersOfArtifacts(
  context: AssociationContext,
  artifacts: GeneratedArtifact[]
): TsImporter[] {
  const importers: TsImporter[] = [];
  const artifactNames = new Map(
    artifacts.map((a) => [a.baseName, a])
  );

  const tsEntries = context.entries.filter(
    (e) => e.languageId === 'typescript' || e.languageId === 'javascript'
  );

  for (const entry of tsEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content) continue;

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const importMatch = line.match(/import\s+.*?from\s+['"]([^'"]+)['"]/);
      if (!importMatch) continue;

      const importPath = importMatch[1];
      const importBaseName = importPath.split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase() ?? '';

      const artifact = artifactNames.get(importBaseName) ??
        Array.from(artifactNames.values()).find((a) => importPath.includes(a.baseName));

      if (!artifact) continue;

      const rel = toRelative(entry.filePath, context.rootPath);
      importers.push({
        fileId: fileNodeId(rel),
        filePath: entry.filePath,
        language: entry.languageId ?? 'typescript',
        artifactId: artifact.artifactId,
        importPath,
        line: i,
      });
    }
  }

  return importers;
}

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}
