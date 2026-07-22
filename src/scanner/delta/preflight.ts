import { existsSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { isGitRepository, commitExistsSafe, isSafeGitRef, revParseSafe } from '../git.js';
import type { DeltaRefusal } from './types.js';

/**
 * Open the primary index read-only *with respect to structural/overlay state* (Decision 14):
 *   - `autoMigrate=false` → no silent migration, no rebuild, no node/edge write on open
 *   - **refuse, never migrate**, a stale-schema index — checked BEFORE any query is prepared
 *   - explicit read-query init only once the schema is confirmed current (that flag skips `initQueries()`)
 * The residual writes are non-structural and sanctioned: the constructor's guarded `mkdirSync`,
 * the adapter's pid owner-marker + one-time legacy WAL→rollback header flip, and the single
 * usage-event append. `existsSync` guards a typo'd `--db` so we refuse rather than create an
 * empty index tree.
 */
export function openDeltaDatabase(dbPath: string): { db: LuxDatabase } | { refusal: DeltaRefusal } {
  if (!existsSync(dbPath)) {
    return {
      refusal: {
        reason: 'db-absent',
        message: `No Lux index at ${dbPath}.`,
        remediation: 'Run `lux index rebuild`, or check --db.',
      },
    };
  }
  const db = new LuxDatabase(dbPath, /* autoMigrate */ false);
  // ⚠️ Order matters: check the schema BEFORE preparing any query. `initReadQueries()`→`initQueries()`
  // constructs `PreparedQueries`, which eagerly prepares ~65 statements — many against
  // current-schema tables/columns a genuinely older index lacks (the `operational_*` tables from
  // migration 011, `structural_edges.ownership` from 013). On such an index those `db.prepare(...)`
  // calls throw `no such table/column`, which would turn the *promised* structured `schema-stale`
  // refusal (Decision 14 / SC-7) into an uncaught crash. `isSchemaUpToDate()` reads only the
  // migration ledger (`migrations.isUpToDate()`), so it is safe on a fresh `autoMigrate=false` open
  // with nothing prepared; `close()` is likewise safe without `initQueries()`.
  if (!db.isSchemaUpToDate()) {
    db.close();
    return {
      refusal: {
        reason: 'schema-stale',
        message: `The index at ${dbPath} is on an older schema.`,
        remediation: 'Run `lux migrate up` (or `lux index rebuild`) — delta refuses to migrate it.',
      },
    };
  }
  db.initReadQueries(); // schema current → safe to prepare (Decision 14: autoMigrate=false skips initQueries())
  return { db };
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
