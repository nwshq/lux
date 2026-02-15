import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';

/**
 * Add migration commands to the CLI program.
 */
export function addMigrateCommands(program: Command) {
  const migrateCmd = program.command('migrate').description('Database migration commands');

  migrateCmd
    .command('status')
    .description('Show migration status')
    .action(() => {
      const opts = program.opts();
      const db = new LuxDatabase(opts.db as string, false); // Don't auto-migrate
      const status = db.getMigrationStatus();

      console.log('\nDatabase Migration Status:\n');
      console.log(`  Current Version: ${status.currentVersion}`);
      console.log(`  Latest Version: ${status.latestVersion}`);
      console.log(`  Status: ${status.isUpToDate ? '✓ Up to date' : '⚠ Migrations pending'}`);
      console.log();

      if (status.appliedMigrations.length > 0) {
        console.log(`Applied Migrations (${status.appliedCount}):`);
        for (const migration of status.appliedMigrations) {
          const date = new Date(migration.applied_at * 1000).toISOString();
          console.log(`  ✓ Version ${migration.version} (applied at ${date})`);
        }
        console.log();
      }

      if (status.pendingMigrations.length > 0) {
        console.log(`Pending Migrations (${status.pendingCount}):`);
        for (const migration of status.pendingMigrations) {
          console.log(`  - Version ${migration.version}: ${migration.name}`);
        }
        console.log();
        console.log('Run "lux migrate up" to apply pending migrations.');
      }

      db.close();
    });

  migrateCmd
    .command('up')
    .description('Run all pending migrations')
    .action(() => {
      const opts = program.opts();
      const db = new LuxDatabase(opts.db as string, false); // Don't auto-migrate

      const status = db.getMigrationStatus();

      if (status.isUpToDate) {
        console.log('✓ Database is already up to date (version ' + status.currentVersion + ')');
        db.close();
        return;
      }

      console.log(`\nRunning ${status.pendingCount} pending migration(s)...\n`);

      const applied = db.runMigrations();

      console.log(`\n✓ Successfully applied ${applied} migration(s)`);
      console.log(`  Database is now at version ${db.getMigrationStatus().currentVersion}`);

      db.close();
    });

  migrateCmd
    .command('create <name>')
    .description('Create a new migration file')
    .action((name: string) => {
      console.log('\nTo create a new migration:');
      console.log('1. Determine the next version number by running: lux migrate status');
      console.log('2. Create a new file in src/db/migrations/ with the format:');
      console.log(`   XXX_${name}.sql`);
      console.log('   (where XXX is the next version number, e.g., 002)');
      console.log('3. Write your migration SQL in the file');
      console.log('4. Run "lux migrate up" to apply it');
      console.log();
    });
}
