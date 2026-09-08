import { extractMobileConstructors } from './constructors.js';
import { extractMobileInterfaces } from './interfaces.js';
import { compareFacts, sortDiagnostics } from './shared.js';
import type {
  MobileAnalysisInputV1,
  MobileExtractionResultV1,
  MobileFactExtractorV1,
  MobileFactV1,
} from './types.js';
import { extractMobileViewModels } from './view-models.js';

/** Compose deterministic mobile architecture facts over shared caches. */
export class MobileFactExtractor implements MobileFactExtractorV1 {
  extract(input: MobileAnalysisInputV1): Promise<MobileExtractionResultV1> {
    const interfaces = extractMobileInterfaces(input);
    const constructors = extractMobileConstructors(input);
    const viewModels = extractMobileViewModels(input);
    const facts: MobileFactV1[] = [
      ...interfaces.interfaces,
      ...interfaces.implementations,
      ...constructors.constructions,
      ...constructors.dependencies,
      ...viewModels.viewModels,
      ...viewModels.uses,
    ];
    return Promise.resolve({
      facts: deduplicate(facts).sort(compareFacts),
      dependencies: [
        ...new Set([
          ...input.project.fingerprintInputs,
          ...input.files.filter((file) => input.sources?.has(file) && input.extractions?.has(file)),
        ]),
      ].sort(),
      diagnostics: sortDiagnostics([
        ...interfaces.diagnostics,
        ...constructors.diagnostics,
        ...viewModels.diagnostics,
      ]),
    });
  }
}

function deduplicate(facts: readonly MobileFactV1[]): MobileFactV1[] {
  const found = new Map<string, MobileFactV1>();
  for (const fact of facts) {
    const location = 'location' in fact ? fact.location : undefined;
    const key = [
      fact.kind,
      fact.filePath,
      location?.line ?? 0,
      location?.column ?? 0,
      JSON.stringify(fact),
    ].join('\0');
    if (!found.has(key)) found.set(key, fact);
  }
  return [...found.values()];
}
