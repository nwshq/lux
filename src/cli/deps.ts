import { Command } from 'commander';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import { LuxDatabase } from '../db/index.js';
import { computeClusters } from '../scanner/imports/clustering.js';
import { resolveModule, detectModuleBoundaries } from '../scanner/imports/module-boundary.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';

export function addDepsCommand(program: Command) {
  const deps = program.command('deps').description('Module dependency analysis');

  deps
    .command('graph')
    .description('Show module dependency graph')
    .option('--module <name>', 'Show dependencies for a specific module')
    .option('--json', 'Output as JSON')
    .action((options: { module?: string; json?: boolean }) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      try {
        if (options.module) {
          showModuleGraph(db, options.module, options.json);
        } else {
          showFullGraph(db, options.json);
        }
      } finally {
        db.close();
      }
    });

  deps
    .command('clusters')
    .description('Show module clusters based on coupling analysis')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      try {
        const allDeps = db.getAllModuleDependencies();
        const clusters = computeClusters(allDeps);

        if (options.json) {
          console.log(JSON.stringify(clusters, null, 2));
          return;
        }

        if (clusters.length === 0) {
          console.log('No module clusters detected. Run "lux index rebuild" first.');
          return;
        }

        console.log(`\nModule Clusters (${clusters.length}):\n`);
        for (const cluster of clusters) {
          console.log(
            `  ${cluster.name} (${cluster.members.length} modules, coupling: ${cluster.couplingScore})`
          );
          for (const member of cluster.members) {
            const marker = member === cluster.name ? ' (hub)' : '';
            console.log(`    - ${member}${marker}`);
          }
          console.log();
        }
      } finally {
        db.close();
      }
    });

  deps
    .command('impact <file-path>')
    .description('Analyze blast radius of changes to a file')
    .option('--json', 'Output as JSON')
    .action((filePath: string, options: { json?: boolean }) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      try {
        const patterns = detectModuleBoundaries(corpusPath);
        const sourceModule = resolveModule(filePath, corpusPath, patterns);

        if (!sourceModule) {
          console.error(`Could not resolve file to a module: ${filePath}`);
          return;
        }

        // Find all modules that depend on this module (target = sourceModule)
        const dependents = db.getModuleDependencies(sourceModule, 'target');

        const impactData = {
          file: relative(corpusPath, filePath) || filePath,
          module: sourceModule,
          dependentModules: dependents.map((d) => ({
            module: d.source_module,
            referenceCount: d.reference_count,
            sampleFiles: d.sample_files ? (JSON.parse(d.sample_files) as string[]) : [],
          })),
          blastRadius: {
            modules: dependents.length,
            totalReferences: dependents.reduce((sum, d) => sum + d.reference_count, 0),
          },
        };

        if (options.json) {
          console.log(JSON.stringify(impactData, null, 2));
          return;
        }

        console.log(`\nImpact Analysis: ${impactData.file}`);
        console.log(`  Module: ${sourceModule}`);
        console.log(
          `  Blast radius: ${impactData.blastRadius.modules} modules, ${impactData.blastRadius.totalReferences} references\n`
        );

        if (dependents.length === 0) {
          console.log('  No dependent modules found.');
        } else {
          console.log('  Dependent modules:');
          for (const dep of impactData.dependentModules) {
            console.log(`    ${dep.module} (${dep.referenceCount} refs)`);
            if (dep.sampleFiles.length > 0) {
              for (const f of dep.sampleFiles.slice(0, 3)) {
                console.log(`      - ${relative(corpusPath, f) || f}`);
              }
            }
          }
        }
        console.log();
      } finally {
        db.close();
      }
    });

  deps
    .command('coverage')
    .description('Check documentation coverage by cluster')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      try {
        const allDeps = db.getAllModuleDependencies();
        const clusters = computeClusters(allDeps);

        const coverageData = clusters.map((cluster) => {
          const documented = cluster.members.filter((member) => {
            // Try common doc locations using detected patterns
            const patterns = detectModuleBoundaries(corpusPath);
            for (const pattern of patterns) {
              const nameIndex = pattern.indexOf('{name}');
              if (nameIndex === -1) continue;
              const prefix = pattern.slice(0, nameIndex);
              const modulePath = join(corpusPath, prefix, member);

              if (
                existsSync(join(modulePath, 'README.md')) ||
                existsSync(join(modulePath, 'docs'))
              ) {
                return true;
              }
            }
            return false;
          });

          return {
            cluster: cluster.name,
            memberCount: cluster.members.length,
            documentedCount: documented.length,
            coverage:
              cluster.members.length > 0
                ? Math.round((documented.length / cluster.members.length) * 100)
                : 0,
            undocumented: cluster.members.filter((m) => !documented.includes(m)),
          };
        });

        if (options.json) {
          console.log(JSON.stringify(coverageData, null, 2));
          return;
        }

        if (coverageData.length === 0) {
          console.log('No clusters found. Run "lux index rebuild" first.');
          return;
        }

        console.log('\nDocumentation Coverage by Cluster:\n');
        for (const item of coverageData) {
          console.log(
            `  ${item.cluster}: ${item.coverage}% (${item.documentedCount}/${item.memberCount} modules)`
          );
          if (item.undocumented.length > 0) {
            console.log(`    Missing docs: ${item.undocumented.join(', ')}`);
          }
        }
        console.log();
      } finally {
        db.close();
      }
    });
}

function showModuleGraph(db: LuxDatabase, module: string, json?: boolean): void {
  const outgoing = db.getModuleDependencies(module, 'source');
  const incoming = db.getModuleDependencies(module, 'target');

  const data = {
    module,
    dependencies: outgoing.map((d) => ({
      target: d.target_module,
      referenceCount: d.reference_count,
    })),
    dependents: incoming.map((d) => ({
      source: d.source_module,
      referenceCount: d.reference_count,
    })),
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`\nModule: ${module}\n`);

  if (outgoing.length > 0) {
    console.log('  Dependencies (imports from):');
    for (const dep of outgoing) {
      console.log(`    → ${dep.target_module} (${dep.reference_count} refs)`);
    }
  } else {
    console.log('  No outgoing dependencies.');
  }

  console.log();

  if (incoming.length > 0) {
    console.log('  Dependents (imported by):');
    for (const dep of incoming) {
      console.log(`    ← ${dep.source_module} (${dep.reference_count} refs)`);
    }
  } else {
    console.log('  No incoming dependencies.');
  }

  console.log();
}

function showFullGraph(db: LuxDatabase, json?: boolean): void {
  const allDeps = db.getAllModuleDependencies();
  const modules = db.getDistinctModules();

  if (json) {
    const graph = modules.map((mod) => {
      const outgoing = allDeps
        .filter((d) => d.source_module === mod)
        .sort((a, b) => b.reference_count - a.reference_count)
        .slice(0, 5);
      const incoming = allDeps
        .filter((d) => d.target_module === mod)
        .sort((a, b) => b.reference_count - a.reference_count)
        .slice(0, 5);

      return {
        module: mod,
        topDependencies: outgoing.map((d) => ({
          target: d.target_module,
          refs: d.reference_count,
        })),
        topDependents: incoming.map((d) => ({ source: d.source_module, refs: d.reference_count })),
      };
    });
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  if (modules.length === 0) {
    console.log('No module dependencies found. Run "lux index rebuild" first.');
    return;
  }

  // Sort by total coupling
  const moduleScores = modules
    .map((mod) => {
      const total = allDeps
        .filter((d) => d.source_module === mod || d.target_module === mod)
        .reduce((sum, d) => sum + d.reference_count, 0);
      return { mod, total };
    })
    .sort((a, b) => b.total - a.total);

  console.log(`\nModule Dependency Graph (${modules.length} modules):\n`);

  for (const { mod, total } of moduleScores) {
    const outgoing = allDeps
      .filter((d) => d.source_module === mod)
      .sort((a, b) => b.reference_count - a.reference_count)
      .slice(0, 5);
    const incoming = allDeps
      .filter((d) => d.target_module === mod)
      .sort((a, b) => b.reference_count - a.reference_count)
      .slice(0, 5);

    console.log(`  ${mod} (total coupling: ${total})`);
    if (outgoing.length > 0) {
      console.log(
        `    → ${outgoing.map((d) => `${d.target_module}(${d.reference_count})`).join(', ')}`
      );
    }
    if (incoming.length > 0) {
      console.log(
        `    ← ${incoming.map((d) => `${d.source_module}(${d.reference_count})`).join(', ')}`
      );
    }
    console.log();
  }
}
