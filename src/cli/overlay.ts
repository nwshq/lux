// CLI command group for overlay inspection and validation.
//
// Commands:
//   lux overlay status  — display current overlay trust state from the DB
//   lux overlay check   — assert overlay is overlay-complete; exits 1 if degraded

import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import {
  describeOverlayTrustInspection,
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../scanner/overlay-trust-state.js';

export function addOverlayCommands(program: Command): void {
  const overlayCmd = program
    .command('overlay')
    .description('Inspect and validate the structural overlay state.');

  // --------------------------------------------------------------------------
  // overlay status
  // --------------------------------------------------------------------------

  overlayCmd
    .command('status')
    .description('Display the current structural overlay trust state.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .action((options: { json?: boolean }) => {
      const opts = program.opts();
      const db = new LuxDatabase(opts.db as string);

      const inspection = inspectOverlayTrustState(db);
      const overlay = inspection.state;
      const diagnostics = describeOverlayTrustInspection(inspection);

      if (options.json) {
        console.log(
          JSON.stringify(
            overlay
              ? {
                  ...overlay,
                  trustLevel: diagnostics.trustLevel,
                  trustSource: diagnostics.trustSource,
                  warnings: diagnostics.warnings,
                }
              : diagnostics,
            null,
            2
          )
        );
      } else if (!overlay) {
        console.log('\nOverlay Status: none');
        console.log(`Trust Level: ${diagnostics.trustLevel}`);
        for (const warning of diagnostics.warnings) {
          console.log(warning);
        }
      } else {
        console.log(`\nOverlay Status: ${overlay.mode}`);
        console.log(`Trust Level: ${diagnostics.trustLevel}`);
        console.log(`Surfaces: ${overlay.surfaceCount}`);
        console.log(
          `Provider kinds: ${overlay.controllerBackedCount} controller-backed, ${overlay.closureBackedCount} closure-backed, ${overlay.unknownProviderKindCount} unknown`
        );
        console.log(`Nodes: ${overlay.fileNodeCount} files, ${overlay.symbolNodeCount} symbols`);
        console.log(`Trust source: ${inspection.source}`);
        if (overlay.lastIndexedCommit) {
          console.log(`Indexed commit: ${overlay.lastIndexedCommit.slice(0, 8)}`);
        }
        if (overlay.recordedAt) {
          console.log(`Trust recorded: ${overlay.recordedAt}`);
        }
        for (const w of overlay.warnings) {
          console.warn(`Warning: ${w}`);
        }
      }

      db.close();
    });

  // --------------------------------------------------------------------------
  // overlay check
  // --------------------------------------------------------------------------

  overlayCmd
    .command('check')
    .description(
      'Assert that the structural overlay is present and non-degraded.\n' +
        '  Exits 0 when surfaces, file nodes, and symbol nodes are all present.\n' +
        '  Exits 1 with a diagnostic when the overlay is absent or degraded.\n' +
        '  Use this as a pre-flight gate in validation scripts and benchmarks.'
    )
    .action(() => {
      const opts = program.opts();
      const db = new LuxDatabase(opts.db as string);

      const inspection = inspectOverlayTrustState(db);
      const overlay = inspection.state;
      const trustLevel = deriveOverlayTrustLevelFromState(overlay);

      db.close();

      if (!overlay) {
        console.error('Error: No structural overlay trust state found in database.');
        console.error('  Trust level: no-overlay');
        console.error('  Run "lux index rebuild" to build the canonical overlay-complete index.');
        process.exit(1);
      }

      if (trustLevel !== 'overlay-complete') {
        console.error(
          `Error: Overlay trust level is ${trustLevel} (persisted mode: ${overlay.mode}), not overlay-complete.`
        );
        for (const warning of overlay.warnings) {
          console.error(`  Warning: ${warning}`);
        }
        console.error('  Run "lux index rebuild" to restore the canonical overlay-complete state.');
        process.exit(1);
      }

      console.log(
        `Overlay check passed: ${overlay.surfaceCount} surface(s), ` +
          `${overlay.fileNodeCount} file node(s), ${overlay.symbolNodeCount} symbol node(s).`
      );
    });
}
