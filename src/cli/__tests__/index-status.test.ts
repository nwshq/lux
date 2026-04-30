import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli', 'index.ts');

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

describe('index status trust diagnostics', () => {
  let repoDir: string;
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-cli-index-status-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-cli-index-status-db-'));
    dbPath = join(dbDir, 'lux.db');

    mkdirSync(join(repoDir, 'docs'), { recursive: true });
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n');

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

  it('reports no-overlay diagnostics before any rebuild', () => {
    const result = runCli(repoDir, dbPath, ['index', 'status']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Structural Overlay:');
    expect(result.stdout).toContain('Trust Level: no-overlay');
    expect(result.stdout).toContain(
      'No overlay trust state recorded. Run "lux index rebuild" to build the canonical overlay path.'
    );
  });

  it('emits canonical index and overlay diagnostics as JSON', () => {
    const result = runCli(repoDir, dbPath, ['index', 'status', '--json']);
    const overlayStatus = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);

    expect(result.status).toBe(0);
    expect(overlayStatus.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      stats: { knowledge_entries: number; events: number };
      overlay: { mode: string; trustLevel: string; trustSource: string; warnings: string[] };
    };
    const overlayPayload = JSON.parse(overlayStatus.stdout) as typeof payload.overlay;

    expect(payload.stats.knowledge_entries).toBe(0);
    expect(payload.overlay).toEqual(overlayPayload);
    expect(payload.overlay.mode).toBe('none');
    expect(payload.overlay.trustLevel).toBe('no-overlay');
    expect(payload.overlay.trustSource).toBe('none');
    expect(payload.overlay.warnings).toContain(
      'No overlay trust state recorded. Run "lux index rebuild" to build the canonical overlay path.'
    );
  });

  it('reports derived content-only trust after content-only rebuild', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only', '--quiet']);
    expect(rebuild.status).toBe(0);

    const result = runCli(repoDir, dbPath, ['index', 'status']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Mode: content-only');
    expect(result.stdout).toContain('Trust Level: content-only');
    expect(result.stdout).toContain('Trust source: derived');
    expect(result.stderr).toContain('Warning: No structural overlay nodes are present');
  });

  it('emits derived content-only trust in index status JSON', () => {
    const rebuild = runCli(repoDir, dbPath, ['index', 'rebuild', '--content-only', '--quiet']);
    expect(rebuild.status).toBe(0);

    const result = runCli(repoDir, dbPath, ['index', 'status', '--json']);
    const overlayStatus = runCli(repoDir, dbPath, ['overlay', 'status', '--json']);

    expect(result.status).toBe(0);
    expect(overlayStatus.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      stats: { knowledge_entries: number };
      overlay: { mode: string; trustLevel: string; trustSource: string; warnings: string[] };
    };
    const overlayPayload = JSON.parse(overlayStatus.stdout) as typeof payload.overlay;

    expect(payload.stats.knowledge_entries).toBeGreaterThan(0);
    expect(payload.overlay).toEqual(overlayPayload);
    expect(payload.overlay.mode).toBe('content-only');
    expect(payload.overlay.trustLevel).toBe('content-only');
    expect(payload.overlay.trustSource).toBe('derived');
    expect(
      payload.overlay.warnings.some((warning) =>
        warning.includes('No structural overlay nodes are present')
      )
    ).toBe(true);
  });
});
