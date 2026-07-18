import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { LuxDatabase } from '../../db/index.js';
import type { StructuralNode } from '../../db/types.js';

/**
 * Ownership of an HTTP surface's handler relative to the app/kernel boundary
 * (E1 cross-repo shared-kernel resolution). Computed over a merged overlay where
 * a first-party shared kernel and the consuming app are both app-source.
 */
export type OwnershipLabel = 'kernel-owned' | 'client-override' | 'client-gap' | 'external';

/**
 * Derive the consuming app's root PHP namespace from `<corpus>/composer.json`
 * `autoload.psr-4` — the entry mapping to `app/`, else the first PSR-4 root, else
 * the Laravel default `App`. Trailing namespace separators are stripped
 * (`"App\\"` → `App`). Graceful (returns `App`) when composer.json is absent or
 * unparseable, so single-repo behavior is unchanged.
 */
export function resolveAppNamespace(corpusPath: string): string {
  const composerPath = join(corpusPath, 'composer.json');
  if (!existsSync(composerPath)) return 'App';
  try {
    const parsed = JSON.parse(readFileSync(composerPath, 'utf-8')) as {
      autoload?: { 'psr-4'?: Record<string, string> };
    };
    const psr4 = parsed.autoload?.['psr-4'];
    if (!psr4) return 'App';
    const entries = Object.entries(psr4);
    const appRoot = entries.find(([, path]) => path.replace(/\/+$/, '') === 'app') ?? entries[0];
    return appRoot ? appRoot[0].replace(/\\+$/, '') : 'App';
  } catch {
    return 'App';
  }
}

/**
 * Classify a handler edge from its target FQCN node-id and the target node (or
 * null if absent). `appNamespace` is the consuming app's root namespace (Laravel
 * default `App`, or derived via {@link resolveAppNamespace}).
 *   - present `<app>\*`                         → client-override (the app handles it)
 *   - present non-`<app>\*`, project-local      → kernel-owned (promoted kernel source)
 *   - present non-`<app>\*`, vendor-pack origin → external (third-party controller,
 *                                                 e.g. Fortify/Jetstream/Nova)
 *   - absent `<app>\*`                          → client-gap (route the client doesn't implement)
 *   - absent non-`<app>\*`                      → external (unresolved third-party)
 */
export function classifyOwnership(
  targetNodeId: string,
  node: StructuralNode | null,
  appNamespace = 'App'
): OwnershipLabel {
  const isApp = targetNodeId.startsWith(`symbol:php:${appNamespace}\\`);
  if (node) {
    if (isApp) return 'client-override';
    // origin defaults to 'local'; a merged vendor-pack node is third-party.
    return (node.origin ?? 'local') === 'local' ? 'kernel-owned' : 'external';
  }
  return isApp ? 'client-gap' : 'external';
}

export interface OwnershipSummary {
  classified: number;
  counts: Record<OwnershipLabel, number>;
}

/**
 * Post-overlay pass: label every `handled_by` edge from an HTTP surface with its
 * {@link OwnershipLabel} and persist it to `structural_edges.ownership`. Runs after
 * the vendor-pack merge so third-party targets are correctly distinguished from
 * genuine client-gaps. Idempotent (a rebuild recomputes from current node state).
 */
export function classifyHandlerOwnership(db: LuxDatabase, appNamespace = 'App'): OwnershipSummary {
  const counts: Record<OwnershipLabel, number> = {
    'kernel-owned': 0,
    'client-override': 0,
    'client-gap': 0,
    external: 0,
  };
  const edges = db.getHandlerEdgesForOwnership();
  const updates: Array<{ id: string; ownership: string }> = [];
  for (const edge of edges) {
    const label = classifyOwnership(
      edge.target_node_id,
      db.getStructuralNode(edge.target_node_id),
      appNamespace
    );
    updates.push({ id: edge.id, ownership: label });
    counts[label]++;
  }
  db.setEdgeOwnershipBatch(updates);
  return { classified: edges.length, counts };
}
