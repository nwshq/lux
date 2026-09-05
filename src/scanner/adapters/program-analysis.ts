import { relative, sep } from 'node:path';

import type { ScanResult } from '../types.js';
import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceFactsV1,
} from '../contracts/program.js';
import { isVueSfcFacts, type VueSfcFactsV1 } from '../vue/types.js';
import {
  buildSharedExtractionAnalysis,
  type SharedExtractionBuildV1,
} from '../ast/extraction-cache.js';

export interface ProgramAnalysisV1 {
  facts: readonly SourceFactsV1[];
  vueFacts: readonly VueSfcFactsV1[];
  project: ProjectResolutionContextV1;
  dependencies: readonly string[];
  diagnostics: readonly SourceDiagnosticV1[];
  producersRun: ReadonlySet<string>;
}

export interface ProgramAnalysisBuildV1 extends ProgramAnalysisV1 {
  /** Internal compatibility substrate consumed by existing overlay materializers/resolvers. */
  shared: SharedExtractionBuildV1;
}

/**
 * Build the canonical parser analysis once for an overlay run. The public facts are
 * contract-shaped while `shared` preserves the legacy extraction substrate until all
 * materializers consume SourceFactsV1 directly.
 */
export async function analyzeProgram(
  scan: ScanResult,
  rootPath: string,
  onWarn?: (message: string) => void
): Promise<ProgramAnalysisBuildV1> {
  const shared = await buildSharedExtractionAnalysis(scan, rootPath, onWarn);
  const sourceFiles = new Set(
    scan.knowledge
      .filter((entry) => entry.type === 'source-code')
      .map((entry) => toRelative(entry.filePath, rootPath))
  );

  return {
    facts: shared.facts,
    vueFacts: shared.facts.filter(isVueSfcFacts),
    project: {
      rootPath,
      sourceFiles,
      aliases: [],
      workspacePackages: [],
      exportsByFile: new Map(),
      fingerprintInputs: [],
    },
    dependencies: [...new Set(shared.dependencies)].sort(),
    diagnostics: shared.diagnostics,
    producersRun: shared.producersRun,
    shared,
  };
}

function toRelative(filePath: string, rootPath: string): string {
  const value = relative(rootPath, filePath);
  if (value !== '' && value !== '..' && !value.startsWith(`..${sep}`)) {
    return value.split(sep).join('/');
  }
  return filePath.split(sep).join('/');
}
