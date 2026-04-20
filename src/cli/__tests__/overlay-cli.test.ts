import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import {
  loadOverlayTrustState,
  inspectOverlayTrustState,
} from '../../scanner/overlay-trust-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');

interface OverlayStatusPayload {
  mode: string;
  trustLevel?: string;
  trustSource: string;
  warnings: string[];
  symbolNodeCount?: number;
  enrichmentStatus?: string;
}

function git(repoPath: string, command: string): string {
  return execSync(command, {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

function runCli(repoPath: string, dbPath: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI_ENTRY, '--db', dbPath, '--corpus', repoPath, ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    }
  );
}

describe('overlay CLI trust surface', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-cli-overlay-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-cli-overlay-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    mkdirSync(join(repoDir, 'src'), { recursive: true });

    writeFileSync(
      join(repoDir, 'lux.yaml'),
      [
        'lsp:',
        '  enabled: true',
        '  enrichers:',
        '    - language_id: typescript',
        '      enabled: true',
        '      server_command: typescript-language-server',
        '      server_args:',
        '        - --stdio',
        'deps:',
        '  enabled: false',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify(
        {
          name: 'overlay-e2e-fixture',
          private: true,
          type: 'module',
          version: '1.0.0',
        },
        null,
        2
      ) + '\n'
    );
    writeFileSync(
      join(repoDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2
      ) + '\n'
    );
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n');
    writeFileSync(
      join(repoDir, 'src', 'app.ts'),
      'export const value = 1;\n' +
        'export function double(x: number) {\n' +
        '  return x * 2;\n' +
        '}\n' +
        'export class Greeter {\n' +
        '  greet(name: string) {\n' +
        '    return `hello ${name}`;\n' +
        '  }\n' +
        '}\n'
    );

    git(repoDir, 'git init');
    git(repoDir, 'git config user.email "test@test.com"');
    git(repoDir, 'git config user.name "Test"');
    git(repoDir, 'git add -A');
    git(repoDir, 'git commit -m "init"');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('content-only rebuild stays unpersisted and derives content-only trust state', () => {
    const result = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Mode: content-only');
    expect(result.stdout).toContain('Trust Level: content-only');
    expect(result.stdout).toContain('fallback path');

    const db = new LuxDatabase(dbPath);
    const persisted = loadOverlayTrustState(db);
    const inspection = inspectOverlayTrustState(db);
    const stats = db.getStats();
    db.close();

    expect(stats.knowledge_entries).toBeGreaterThan(0);
    expect(persisted).toBeNull();
    expect(inspection.source).toBe('derived');
    expect(inspection.state?.mode).toBe('content-only');
  });

  it('overlay status reports no-overlay diagnostics before any rebuild', () => {
    const db = new LuxDatabase(dbPath);
    db.close();

    const result = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);

    expect(result.status).toBe(0);
    const payload: OverlayStatusPayload = JSON.parse(result.stdout) as OverlayStatusPayload;
    expect(payload.mode).toBe('none');
    expect(payload.trustLevel).toBe('no-overlay');
    expect(payload.trustSource).toBe('none');
    expect(payload.warnings).toContain(
      'No overlay trust state recorded. Run "lux index rebuild" to build the canonical overlay path.'
    );
  });

  it('overlay status reports derived content-only state after content-only rebuild', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only', '--quiet']);
    expect(rebuild.status).toBe(0);

    const result = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);

    expect(result.status).toBe(0);
    const payload: OverlayStatusPayload = JSON.parse(result.stdout) as OverlayStatusPayload;
    expect(payload.mode).toBe('content-only');
    expect(payload.trustLevel).toBe('content-only');
    expect(payload.trustSource).toBe('derived');
    expect(
      payload.warnings.some((warning) =>
        warning.includes('No structural overlay nodes are present')
      )
    ).toBe(true);
  });

  it('overlay check fails with no-overlay diagnostics before any rebuild', () => {
    const db = new LuxDatabase(dbPath);
    db.close();

    const result = runCli(repoDir, dbPath, ['overlay', 'check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error: No structural overlay trust state found in database.');
    expect(result.stderr).toContain('Trust level: no-overlay');
  });

  it('overlay check fails against content-only state', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only', '--quiet']);
    expect(rebuild.status).toBe(0);

    const result = runCli(repoDir, dbPath, ['overlay', 'check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Error: Overlay trust level is content-only (persisted mode: content-only), not overlay-complete.'
    );
    expect(result.stderr).toContain(
      'Run "lux index rebuild" to restore the canonical overlay-complete state.'
    );
  });

  it('canonical rebuild reaches real overlay-complete state when symbols materialize', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--quiet']);
    expect(rebuild.status).toBe(0);
    expect(rebuild.stdout).toContain('▶ index rebuild (overlay-complete)');
    expect(rebuild.stdout).toContain('Scanning content directory:');
    expect(rebuild.stdout).toContain('Rebuilding structural overlay...');
    expect(rebuild.stdout).toContain('✓ index rebuild complete in ');
    expect(rebuild.stdout).toContain('✓ Index rebuilt successfully (overlay-complete, ');

    const db = new LuxDatabase(dbPath);
    const trustState = loadOverlayTrustState(db);
    const stats = db.getStats();
    const guide = db.getKnowledgeEntryByPath(join(repoDir, 'docs', 'guide.md'));
    db.close();

    expect(trustState).not.toBeNull();
    expect(trustState?.mode).toBe('overlay-complete');
    expect(trustState?.symbolNodeCount).toBeGreaterThan(0);
    expect(trustState?.sourceAction).toBe('index-rebuild');
    expect(stats.knowledge_entries).toBeGreaterThan(0);
    expect(guide?.content).toContain('Guide');

    const status = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);
    const check = runCli(repoDir, dbPath, ['overlay', 'check']);

    expect(status.status).toBe(0);
    const payload: OverlayStatusPayload = JSON.parse(status.stdout) as OverlayStatusPayload;
    expect(payload.mode).toBe('overlay-complete');
    expect(payload.trustLevel).toBe('overlay-complete');
    expect(payload.trustSource).toBe('persisted');
    expect(payload.symbolNodeCount).toBeGreaterThan(0);
    expect(payload.enrichmentStatus).toBe('active');
    expect(payload.warnings).toEqual([]);

    expect(check.status).toBe(0);
    expect(check.stdout).toContain('Overlay check passed:');
  });
});
