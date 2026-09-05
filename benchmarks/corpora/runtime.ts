import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_CORPUS_MANIFEST,
  isPathSafeCorpusOrCaseId,
  loadCorpusManifest,
  withPreflightCorpora,
  type CorpusManifestEntryV1,
  type CorpusManifestV1,
  type CorpusResolutionV1,
} from './preflight.js';

export interface PortableFixtureIdentityV1 {
  schemaVersion: 1;
  goldSchemaVersion: 1;
  owner: string;
  corpusId: string;
}

export type BatchPreflightV1 = typeof withPreflightCorpora;

export interface BenchmarkBarrierOptionsV1 {
  manifestPath?: string;
  checkoutOverrides?: Readonly<Record<string, string>>;
  corpusIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadCheckoutOverrides(path: string): Readonly<Record<string, string>> {
  const resolvedPath = resolve(path);
  let parsed: unknown;
  try {
    if (lstatSync(resolvedPath).isSymbolicLink()) {
      throw new Error('must not be a symbolic link');
    }
    parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Checkout overrides must be a readable JSON path-only map${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('Checkout overrides must be a JSON object mapping corpus IDs to paths');
  }
  const overrides: Record<string, string> = {};
  for (const [corpusId, checkoutPath] of Object.entries(parsed)) {
    if (!isPathSafeCorpusOrCaseId(corpusId)) {
      throw new Error(`Checkout override has an unsafe corpus ID: ${corpusId}`);
    }
    if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
      throw new Error(`Checkout override for ${corpusId} must be one non-empty path string`);
    }
    overrides[corpusId] = checkoutPath;
  }
  return overrides;
}

export function loadRunnerManifest(path?: string): {
  path: string;
  manifest: CorpusManifestV1;
  entries: ReadonlyMap<string, CorpusManifestEntryV1>;
} {
  const manifestPath = resolve(path ?? DEFAULT_CORPUS_MANIFEST);
  const manifest = loadCorpusManifest(manifestPath);
  return {
    path: manifestPath,
    manifest,
    entries: new Map(manifest.corpora.map((entry) => [entry.id, entry])),
  };
}

export function validateFixtureIdentity(
  fixture: PortableFixtureIdentityV1,
  fixturePath: string,
  manifest: CorpusManifestV1,
  entries: ReadonlyMap<string, CorpusManifestEntryV1>
): CorpusManifestEntryV1 {
  if (fixture.schemaVersion !== 1) {
    throw new Error(`${fixturePath}: fixture schemaVersion must be 1`);
  }
  if (!isPathSafeCorpusOrCaseId(fixture.corpusId)) {
    throw new Error(`${fixturePath}: corpusId must be one path-safe ID`);
  }
  const entry = entries.get(fixture.corpusId);
  if (!entry) {
    throw new Error(
      `${fixturePath}: corpusId ${fixture.corpusId} is not in the selected owner-approved manifest; refusing this legacy/noncanonical fixture`
    );
  }
  if (fixture.owner !== manifest.owner) {
    throw new Error(
      `${fixturePath}: fixture owner ${JSON.stringify(fixture.owner)} does not match manifest owner ${JSON.stringify(manifest.owner)}`
    );
  }
  if (fixture.schemaVersion !== entry.fixtureSchemaVersion) {
    throw new Error(
      `${fixturePath}: fixture schemaVersion ${fixture.schemaVersion} does not match manifest fixtureSchemaVersion ${entry.fixtureSchemaVersion}`
    );
  }
  if (fixture.goldSchemaVersion !== entry.goldSchemaVersion) {
    throw new Error(
      `${fixturePath}: goldSchemaVersion ${fixture.goldSchemaVersion} does not match manifest goldSchemaVersion ${entry.goldSchemaVersion}`
    );
  }
  return entry;
}

/** Execute benchmark runtime work only after T17 resolves every selected corpus in isolation. */
export async function withBenchmarkCorpora<T>(
  options: BenchmarkBarrierOptionsV1,
  operation: (resolutions: ReadonlyMap<string, CorpusResolutionV1>) => T | Promise<T>,
  batchPreflight: BatchPreflightV1 = withPreflightCorpora
): Promise<T> {
  return batchPreflight(
    {
      corpusIds: options.corpusIds,
      manifestPath: options.manifestPath,
      checkoutOverrides: options.checkoutOverrides,
      isolation: 'always',
    },
    async (resolutions) => {
      if (resolutions.some((resolution) => !resolution.isolated)) {
        throw new Error('Real-corpus benchmarks require isolated pinned roots');
      }
      return operation(new Map(resolutions.map((resolution) => [resolution.id, resolution])));
    }
  );
}
