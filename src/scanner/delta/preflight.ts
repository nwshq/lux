import { LuxDatabase } from '../../db/index.js';
import { openIndex, type IndexOpenRefusal } from '../../db/open-policy.js';
import { isGitRepository, commitExistsSafe, isSafeGitRef, revParseSafe } from '../git.js';
import type { DeltaRefusal } from './types.js';

/** Map the shared strict-open refusal vocabulary to delta's stable public refusal contract. */
export function mapIndexOpenRefusal(refusal: IndexOpenRefusal, message: string): DeltaRefusal {
  switch (refusal) {
    case 'index-absent':
      return {
        reason: 'db-absent',
        message,
        remediation: 'Run `lux index rebuild`, or check --db.',
      };
    case 'schema-too-old':
      return {
        reason: 'schema-stale',
        message,
        remediation: 'Run `lux migrate up` (or `lux index rebuild`) — delta refuses to migrate it.',
      };
    case 'schema-too-new':
    case 'db-unreadable':
      return {
        reason: 'config-error',
        message,
        remediation:
          refusal === 'schema-too-new'
            ? 'Upgrade Lux before running delta.'
            : 'Check --db, or run `lux index rebuild` explicitly.',
      };
  }
}

/** Compatibility seam for non-CLI callers; applies the same strict read-existing policy. */
export function openDeltaDatabase(dbPath: string): { db: LuxDatabase } | { refusal: DeltaRefusal } {
  const opened = openIndex(dbPath, 'read-existing');
  return opened.ok
    ? { db: opened.db }
    : { refusal: mapIndexOpenRefusal(opened.refusal, opened.message) };
}

export interface BaseResolution {
  ref: string;
  sha: string | null;
  source: 'flag' | 'index';
}

/**
 * Resolve the diff base (Decision 1): `--base` when given, else the index's
 * `last_indexed_commit`. Returns a `DeltaRefusal` when the corpus is not a git repo (Decision 18),
 * the base is malformed (Decision 17), or the base is unresolvable in this checkout (shallow
 * clone — Decision 18). The caller degrades these to warnings in analysis mode and refuses under
 * `--check`.
 */
export function resolveDeltaBase(
  corpusPath: string,
  db: LuxDatabase,
  base: string | undefined
): BaseResolution | DeltaRefusal {
  if (!isGitRepository(corpusPath)) {
    return {
      reason: 'not-a-git-repo',
      message: `${corpusPath} is not a git repository — delta needs a git diff source.`,
    };
  }
  let ref: string;
  let source: 'flag' | 'index';
  if (base !== undefined) {
    if (!isSafeGitRef(base)) {
      return {
        reason: 'baseline-unavailable',
        message: `--base ${JSON.stringify(base)} is not a valid ref (must match ^[A-Za-z0-9._/@^~-]+$, no leading '-').`,
      };
    }
    ref = base;
    source = 'flag';
  } else {
    const indexed = db.getIndexMetadata('last_indexed_commit');
    if (!indexed) {
      return {
        reason: 'baseline-unavailable',
        message: 'No --base given and the index has no last_indexed_commit to diff against.',
        remediation: 'Pass --base <ref>, or run `lux index rebuild`.',
      };
    }
    ref = indexed;
    source = 'index';
  }
  if (!commitExistsSafe(corpusPath, ref)) {
    return {
      reason: 'baseline-unavailable',
      message: `Base ref ${ref} does not exist in this checkout (shallow clone?).`,
      remediation:
        'Fetch it (CI: actions/checkout with fetch-depth: 0), or pass a reachable --base.',
    };
  }
  return { ref, sha: revParseSafe(corpusPath, ref), source };
}

export function isRefusal(x: object): x is DeltaRefusal {
  return 'reason' in x && 'message' in x;
}
