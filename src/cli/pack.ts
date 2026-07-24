import type { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../db/index.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import { LUX_VERSION } from '../utils/version.js';
import { ensureVendorPack } from '../scanner/pack/pack-builder.js';
import { lookupPack, VENDOR_PACK_KEY_META, type PackKeyScheme } from '../scanner/pack/cache.js';
import { VendorPackReader, type VendorPackDepth } from '../scanner/pack/pack-format.js';

export function addVendorPackCommands(program: Command): void {
  const cmd = program
    .command('vendor-pack')
    .description('Build and inspect the cached vendor structural pack');

  cmd
    .command('build')
    .description('Build (or reuse) the vendor pack for the project composer.lock')
    .option('--depth <depth>', "Within-vendor depth: 'full-lsp' (default) or 'ast-only'")
    .option('--scheme <scheme>', "Keying: 'composer-lock' (default) or 'per-package'")
    .option(
      '--pack-cache <dir>',
      'Override pack cache root (else LUX_PACK_CACHE, else ~/.lux/packs)'
    )
    .option('--force', 'Rebuild even if a matching pack is already cached')
    .action(
      async (options: { depth?: string; scheme?: string; packCache?: string; force?: boolean }) => {
        const opts = program.opts();
        const projectRoot = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
        if (!existsSync(join(projectRoot, 'composer.lock'))) {
          console.error(
            `Error: no composer.lock at ${projectRoot} — vendor-pack requires a Composer project.`
          );
          process.exit(1);
        }
        const depth = (options.depth ?? 'full-lsp') as VendorPackDepth;
        const scheme = (options.scheme ?? 'composer-lock') as PackKeyScheme;

        const result = await ensureVendorPack(projectRoot, {
          depth,
          scheme,
          packCache: options.packCache,
          force: options.force,
          luxVersion: LUX_VERSION,
          onProgress: (m) => console.log(`  ${m}`),
        });

        // Record the key the project is aligned to, so the merge path can detect
        // staleness and re-import on the next rebuild.
        const db = new LuxDatabase(
          resolveDbPath({ corpus: projectRoot, db: opts.db as string | undefined })
        );
        db.setIndexMetadata(VENDOR_PACK_KEY_META, result.manifest.key);
        db.close();

        console.log(
          `\n✓ Vendor pack ${result.built ? 'built' : 'reused from cache'} ` +
            `(${result.manifest.nodeCount} nodes, ${result.manifest.edgeCount} edges, depth=${result.manifest.depth})`
        );
        console.log(`  ${result.packPath}`);
      }
    );

  cmd
    .command('status')
    .description('Show the resolved pack key and cache state for this project')
    .option('--scheme <scheme>', "Keying: 'composer-lock' (default) or 'per-package'")
    .option('--pack-cache <dir>', 'Override pack cache root')
    .action((options: { scheme?: string; packCache?: string }) => {
      const opts = program.opts();
      const projectRoot = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      if (!existsSync(join(projectRoot, 'composer.lock'))) {
        console.error(`Error: no composer.lock at ${projectRoot}.`);
        process.exit(1);
      }
      const scheme = (options.scheme ?? 'composer-lock') as PackKeyScheme;
      const lookup = lookupPack(projectRoot, { scheme, packCache: options.packCache });

      console.log('\nVendor pack status:\n');
      console.log(`  Project: ${projectRoot}`);
      console.log(`  Key (${lookup.key.scheme}): ${lookup.key.digest.slice(0, 16)}…`);
      if (lookup.key.framework) console.log(`  Framework: ${lookup.key.framework}`);
      console.log(`  Expected pack: ${lookup.packPath}`);
      console.log(`  Cached: ${lookup.hit ? 'yes (usable)' : 'no — run "lux vendor-pack build"'}`);

      if (lookup.hit) {
        const reader = new VendorPackReader(lookup.packPath);
        const m = reader.manifest();
        reader.close();
        const builtAt = new Date(m.builtAt * 1000).toISOString();
        console.log(
          `  Contents: ${m.nodeCount} nodes, ${m.edgeCount} edges, depth=${m.depth}, ` +
            `built ${builtAt} in ${(m.buildDurationMs / 1000).toFixed(1)}s (lux ${m.luxVersion})`
        );
      }

      const db = new LuxDatabase(
        resolveDbPath({ corpus: projectRoot, db: opts.db as string | undefined })
      );
      const merged = db.getIndexMetadata(VENDOR_PACK_KEY_META);
      db.close();
      console.log(
        `  Merged into project DB: ${
          merged ? (merged === lookup.key.digest ? 'yes (current)' : 'STALE — different key') : 'no'
        }`
      );
    });
}
