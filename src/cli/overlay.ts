// CLI command group for overlay inspection and validation.
//
// Commands:
//   lux overlay status  — display current overlay trust state from the DB
//   lux overlay check   — assert overlay is overlay-complete; exits 1 if degraded

import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';

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

      const surfaces = db.getCapabilitySurfaces();
      const fileNodes = db.getStructuralNodesByType('file');
      const symbolNodes = db.getStructuralNodesByType('symbol');

      let controllerBacked = 0;
      let closureBacked = 0;
      let unknownKind = 0;

      for (const surface of surfaces) {
        if (surface.metadata) {
          try {
            const meta = JSON.parse(surface.metadata) as Record<string, unknown>;
            if (meta.providerKind === 'controller') controllerBacked++;
            else if (meta.providerKind === 'closure') closureBacked++;
            else unknownKind++;
          } catch {
            unknownKind++;
          }
        } else {
          unknownKind++;
        }
      }

      const warnings: string[] = [];
      if (surfaces.length > 0 && symbolNodes.length === 0) {
        warnings.push(
          'Surface nodes exist but no symbol nodes are present — overlay may lack provider resolution.'
        );
      }

      const mode =
        surfaces.length === 0 && fileNodes.length === 0
          ? 'no-overlay'
          : symbolNodes.length === 0 && surfaces.length > 0
            ? 'degraded-overlay'
            : 'overlay-present';

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              mode,
              surfaceCount: surfaces.length,
              fileNodeCount: fileNodes.length,
              symbolNodeCount: symbolNodes.length,
              controllerBackedCount: controllerBacked,
              closureBackedCount: closureBacked,
              unknownProviderKindCount: unknownKind,
              warnings,
            },
            null,
            2
          )
        );
      } else {
        console.log(`\nOverlay Status: ${mode}`);
        console.log(`Surfaces: ${surfaces.length}`);
        if (surfaces.length > 0) {
          console.log(
            `Provider kinds: ${controllerBacked} controller-backed, ${closureBacked} closure-backed, ${unknownKind} unknown`
          );
        }
        console.log(`Nodes: ${fileNodes.length} files, ${symbolNodes.length} symbols`);
        for (const w of warnings) {
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

      const surfaces = db.getCapabilitySurfaces();
      const fileNodes = db.getStructuralNodesByType('file');
      const symbolNodes = db.getStructuralNodesByType('symbol');

      db.close();

      if (surfaces.length === 0 && fileNodes.length === 0) {
        console.error('Error: No structural overlay found in database.');
        console.error(
          '  Run "lux index rebuild" to build the canonical overlay-complete index.'
        );
        process.exit(1);
      }

      if (symbolNodes.length === 0) {
        console.error('Error: Overlay is degraded — no symbol nodes are present.');
        console.error(
          '  Provider propagation trust is reduced without symbol materialization.'
        );
        console.error(
          '  Run "lux index rebuild" with LSP enrichment enabled.'
        );
        process.exit(1);
      }

      console.log(
        `Overlay check passed: ${surfaces.length} surface(s), ` +
          `${fileNodes.length} file node(s), ${symbolNodes.length} symbol node(s).`
      );
    });
}
