import { existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { getHeadCommit } from '../git.js';
import { resolveAppNamespace } from './ownership.js';
import type { KernelOverlayConfig } from '../config.js';

/**
 * A resolved cross-area kernel: the sibling area (a composer path-repo the client vendors)
 * whose already-built `.lux` index is joined read-only for ownership classification (#62).
 */
export interface ResolvedKernel {
  /** `<worktree>/.lux/lux.db` — the kernel's built index. */
  dbPath: string;
  /** `realpath(<corpus>/vendor/<package>)` — the kernel worktree the client actually vendors. */
  worktree: string;
  /** The kernel's root PHP namespace (e.g. `acme\\Core`), from its composer.json. */
  namespace: string;
  /** The kernel index's `last_indexed_commit`, if recorded. */
  indexedCommit?: string;
  /** The vendored worktree's current git HEAD (for the drift check). */
  headCommit?: string;
}

/**
 * Resolve the kernel from the client's `vendor/<package>` symlink (NOT a free-form path —
 * the vendored worktree is authoritative). Fails loud, never silently classifying against
 * the wrong kernel:
 *   - `vendor/<package>` absent / not a symlink → error
 *   - `override` path disagrees with the symlink realpath → error
 *   - the vendored worktree has no `.lux` index → fail fast ("index it first")
 *
 * The kernel index is opened with the raw read-only `LuxSqlite` adapter (never `LuxDatabase`,
 * whose autoMigrate would write the kernel file) to read schema/commit metadata.
 */
export function resolveKernel(
  corpusPath: string,
  cfg: KernelOverlayConfig,
  override?: string
): ResolvedKernel {
  const vendorPath = join(corpusPath, 'vendor', cfg.package);
  let worktree: string;
  try {
    worktree = realpathSync(vendorPath);
  } catch {
    throw new Error(
      `Cross-area overlay: vendor/${cfg.package} not found under ${corpusPath} — expected a symlinked path-repo kernel.`
    );
  }

  if (override) {
    let overrideReal: string;
    try {
      overrideReal = realpathSync(override);
    } catch {
      throw new Error(`Cross-area overlay: --kernel path not found: ${override}`);
    }
    if (overrideReal !== worktree) {
      throw new Error(
        `Cross-area overlay: --kernel (${overrideReal}) disagrees with the vendored kernel (${worktree}).`
      );
    }
  }

  let headCommit: string | undefined;
  try {
    headCommit = getHeadCommit(worktree);
  } catch {
    headCommit = undefined;
  }

  const dbPath = join(worktree, '.lux', 'lux.db');
  if (!existsSync(dbPath)) {
    const at = headCommit ? ` @ ${headCommit.slice(0, 7)}` : '';
    throw new Error(
      `Cross-area overlay: the kernel you vendor (${worktree}${at}) has no Lux index — run \`lux index rebuild\` there first.`
    );
  }

  const namespace = resolveAppNamespace(worktree);

  let indexedCommit: string | undefined;
  const kdb = new LuxSqlite(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = kdb.get("SELECT value FROM index_metadata WHERE key = 'last_indexed_commit'") as
      { value?: string } | undefined;
    indexedCommit = row?.value ?? undefined;
  } finally {
    kdb.close();
  }

  return { dbPath, worktree, namespace, indexedCommit, headCommit };
}
