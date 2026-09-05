#!/usr/bin/env npx tsx
//
// SC-6 — scoped-refresh same-run timing check (spec 14 Part F).
//
// This is a LIVE post-build check on a REAL repo (auctic-core), NOT part of the green-before-commit
// unit gate (the equivalence oracle in src/scanner/associations/__tests__/ is that). It needs a real
// repo with a built overlay, so it lives here and is recorded at ship, per the payload.
//
// Contract (SC-6): a 1-file scoped refresh completes within the FULL-REBUILD baseline recorded IN
// THE SAME RUN (the AST tier is seconds-scale — target an order of magnitude under). The comparison
// is against the same-run baseline, not a fixed wall-clock, so the still-open OQ1 (budget default)
// cannot invalidate the criterion.
//
// Usage:
//   npm run benchmark:scoped-refresh -- /abs/path/to/auctic-core [relPathToTouch]
//   LUX_BENCH_REPO=/abs/path/to/auctic-core npm run benchmark:scoped-refresh

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LuxDatabase } from '../../src/db/index.js';
import { rebuildWithOverlay } from '../../src/scanner/rebuild-orchestrator.js';
import { loadLspConfig } from '../../src/scanner/config.js';
import {
  refreshOverlayScoped,
  type ChangedFile,
} from '../../src/scanner/associations/overlay-refresh.js';
import { collectOverlayRelevantPaths } from '../../src/scanner/incremental.js';
import { getGitDiff, getHeadCommit } from '../../src/scanner/git.js';

function ms(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function main(): Promise<void> {
  const repo = process.argv[2] ?? process.env.LUX_BENCH_REPO;
  if (!repo) {
    console.error('Usage: benchmark:scoped-refresh -- <repoPath> [relPathToTouch]');
    console.error('  (repo must be a git working tree; a 1-file dirty change is used as F)');
    process.exit(2);
  }
  const forcedFile = process.argv[3];

  const dbDir = mkdtempSync(join(tmpdir(), 'lux-sc6-'));
  const db = new LuxDatabase(join(dbDir, 'lux.db'));
  try {
    // 1. Full rebuild — the same-run baseline.
    const t0 = ms();
    await rebuildWithOverlay(db, repo);
    const fullMs = ms() - t0;
    console.log(`full rebuild baseline: ${fullMs} ms`);

    // 2. Determine a 1-file change set. Prefer the working-tree dirty set; else the last commit's diff.
    let changedPaths: string[] = [];
    if (forcedFile) {
      changedPaths = [forcedFile];
    } else {
      const head = getHeadCommit(repo);
      const diff = getGitDiff(repo, `${head}~1`, head);
      changedPaths = collectOverlayRelevantPaths(diff).slice(0, 1);
    }
    if (changedPaths.length === 0) {
      console.error('No overlay-relevant 1-file change found; pass a relPath as the 2nd arg.');
      process.exit(2);
    }
    const changed: ChangedFile[] = changedPaths.map((relPath) => ({ relPath, status: 'modified' }));
    console.log(`scoped refresh over: ${changedPaths.join(', ')}`);

    // 3. Scoped refresh — timed. Default budget (30s LSP); AST tier is what SC-6 measures.
    const t1 = ms();
    const result = await refreshOverlayScoped(db, repo, changed, loadLspConfig(repo));
    const scopedMs = ms() - t1;

    console.log(
      `scoped refresh: ${scopedMs} ms ` +
        `(|R|=${result.refreshedFiles}, closure=${result.closureFiles}, ` +
        `tiers ast=${result.tiers.ast} lsp=${result.tiers.lsp} facade=${result.tiers.facade}, ` +
        `residualStale=${result.residualStaleEdges})`
    );

    // SC-6 assertion: scoped within the same-run full-rebuild baseline.
    if (scopedMs >= fullMs) {
      console.error(
        `SC-6 FAIL: scoped refresh (${scopedMs} ms) was NOT under the full-rebuild baseline (${fullMs} ms).`
      );
      process.exit(1);
    }
    const factor = fullMs / Math.max(scopedMs, 1);
    console.log(
      `SC-6 PASS: scoped refresh is ${factor.toFixed(1)}× under the same-run full-rebuild baseline.`
    );
  } finally {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
