import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { resolveRuntimePaths } from '../utils/runtime-paths.js';
import {
  buildFederationBlock,
  resolveSiblings,
  type SiblingResolution,
} from '../scanner/siblings.js';
import { createInvocationId, emitUsageEvent } from '../db/observability/usage-event.js';

export function addSiblingsCommand(program: Command): void {
  const siblings = program
    .command('siblings')
    .description('Inspect the cross-repo sibling registry');
  siblings
    .command('status')
    .description(
      'List every registered sibling with worktree, schema version, indexed-vs-HEAD drift, and ' +
        'staleness. Report-only (exit 0); unresolvable siblings render a structured refusal.'
    )
    .option('--json', 'Emit the per-sibling federation records')
    .action((options: { json?: boolean }) => {
      const opts = program.opts();
      const runtime = resolveRuntimePaths({
        corpus: opts.corpus as string | undefined,
        db: opts.db as string | undefined,
      });
      const db = new LuxDatabase(runtime.dbPath);
      const invocationId = createInvocationId();
      const startedAt = Date.now();
      try {
        const primarySchema = db.getAppliedSchemaVersion();
        const resolutions = resolveSiblings(runtime.corpusPath, 'all', primarySchema);
        if (options.json) {
          console.log(JSON.stringify(buildFederationBlock(resolutions), null, 2));
        } else {
          renderSiblingsStatus(resolutions);
        }
        emitUsageEvent(db, {
          source: 'cli',
          surface: 'siblings',
          action: 'status',
          invocationId,
          commandOutcome: 'success',
          exitCode: 0,
          corpusPath: runtime.corpusPath,
          dbPath: runtime.dbPath,
          durationMs: Date.now() - startedAt,
          attributes: {
            siblings: resolutions.length,
            refusals: resolutions.filter((r) => 'refusal' in r).length,
          },
        });
      } finally {
        db.close();
      }
    });
}

function renderSiblingsStatus(resolutions: SiblingResolution[]): void {
  if (resolutions.length === 0) {
    console.log(
      'No siblings registered (add a `siblings:` block or `overlay.kernel.package` to lux.yaml).'
    );
    return;
  }
  console.log('');
  for (const r of resolutions) {
    if ('refusal' in r) {
      console.log(`${r.name.padEnd(14)} ${r.refusal.reason.toUpperCase()}  — ${r.refusal.message}`);
      console.log(`${''.padEnd(14)} ↳ ${r.refusal.remediation}`);
      continue;
    }
    const s = r.sibling;
    const loc = s.worktree ?? `(db-only) ${s.dbPath}`;
    const schema = s.schemaVersion !== undefined ? `schema ${s.schemaVersion}` : 'schema ?';
    let drift: string;
    if (!s.headCommit) {
      drift = 'drift unknown';
    } else if (s.indexedCommit === s.headCommit) {
      drift = `indexed ${short(s.indexedCommit)} = HEAD          fresh`;
    } else {
      drift = `indexed ${short(s.indexedCommit)} ≠ HEAD ${short(s.headCommit)}  STALE`;
    }
    console.log(`${s.name.padEnd(14)} ${s.role.padEnd(6)} ${loc.padEnd(42)} ${schema}  ${drift}`);
  }
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '???????';
}
