import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyInitPlan,
  buildInitPlan,
  renderInitPlan,
  runInit,
  writeAtomicallyInsideRoot,
} from '../index.js';

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'lux-init-'));
  roots.push(value);
  return value;
}

afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('portable init', () => {
  it('plans a deterministic portable config and ignore for a clean unconfigured corpus', () => {
    const corpus = root();
    writeFileSync(join(corpus, 'package.json'), '{}\n');
    writeFileSync(join(corpus, 'view.vue'), '<template/>\n');
    const first = buildInitPlan(corpus);
    const second = buildInitPlan(corpus);

    expect(first).toEqual(second);
    expect(first.detected).toEqual(['language:javascript', 'language:vue']);
    expect(first.changes.map(({ action, path }) => ({ action, path }))).toEqual([
      { action: 'create', path: 'lux.yaml' },
      { action: 'create', path: '.gitignore' },
    ]);
    const config = first.changes[0].content;
    expect(config).toContain('schema_version: 1');
    expect(config).toContain('workspace:\n  root: .');
    expect(config).toContain('index:\n  database: .lux/lux.db');
    expect(config).toContain('workspace_root: .');
    expect(config).toContain('server_command: vue-language-server');
    expect(config).not.toContain(corpus);
    expect(renderInitPlan(first)).not.toContain(corpus);
  });

  it('defaults to preview/no-write and --yes seam applies byte-identically twice', () => {
    const corpus = root();
    writeFileSync(join(corpus, 'main.ts'), 'export {};\n');
    runInit({ corpusRoot: corpus });
    expect(existsSync(join(corpus, 'lux.yaml'))).toBe(false);

    runInit({ corpusRoot: corpus, yes: true });
    const config = readFileSync(join(corpus, 'lux.yaml'));
    const ignore = readFileSync(join(corpus, '.gitignore'));
    const second = runInit({ corpusRoot: corpus, yes: true });
    expect(second.changes.every((change) => change.action === 'unchanged')).toBe(true);
    expect(readFileSync(join(corpus, 'lux.yaml'))).toEqual(config);
    expect(readFileSync(join(corpus, '.gitignore'))).toEqual(ignore);
  });

  it('preserves configured sections and appends only missing portable sections', () => {
    const corpus = root();
    writeFileSync(join(corpus, 'lux.yaml'), 'lsp:\n  enabled: false\n');
    writeFileSync(join(corpus, '.gitignore'), 'node_modules/\n.lux/\n');
    const plan = buildInitPlan(corpus);
    expect(plan.changes[0]).toMatchObject({ action: 'append', beforeHash: expect.any(String) });
    expect(plan.changes[0].content.match(/^lsp:/gmu)).toHaveLength(1);
    expect(plan.changes[0].content).toContain('deps:\n');
    expect(plan.changes[1].action).toBe('unchanged');
  });

  it('JSON projection redacts the absolute corpus root', async () => {
    const corpus = root();
    writeFileSync(join(corpus, 'main.ts'), 'export {};\n');
    const plan = buildInitPlan(corpus);
    const json = JSON.stringify({ ...plan, corpusRoot: '.' });
    expect(json).not.toContain(corpus);
    expect(JSON.parse(json)).toMatchObject({ corpusRoot: '.' });
  });

  it('declined apply leaves dirty targets untouched and changed hashes are rejected', () => {
    const corpus = root();
    writeFileSync(join(corpus, 'lux.yaml'), 'custom: true\n');
    writeFileSync(join(corpus, '.gitignore'), 'dist/\n');
    const plan = buildInitPlan(corpus);
    applyInitPlan(plan, false);
    expect(readFileSync(join(corpus, 'lux.yaml'), 'utf8')).toBe('custom: true\n');

    writeFileSync(join(corpus, 'lux.yaml'), 'custom: changed\n');
    expect(() => applyInitPlan(plan, true)).toThrow(/hash mismatch/u);
    expect(readFileSync(join(corpus, 'lux.yaml'), 'utf8')).toBe('custom: changed\n');
  });

  it('refuses generic apply over uncommitted target changes', () => {
    const corpus = root();
    execFileSync('git', ['init', '-q'], { cwd: corpus });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: corpus });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: corpus });
    writeFileSync(join(corpus, 'lux.yaml'), 'custom: true\n');
    execFileSync('git', ['add', 'lux.yaml'], { cwd: corpus });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: corpus });
    writeFileSync(join(corpus, 'lux.yaml'), 'custom: owner-work\n');
    const plan = buildInitPlan(corpus);
    expect(plan.changes[0]).toMatchObject({ dirty: true });
    expect(() => applyInitPlan(plan, true)).toThrow(/dirty init target/u);
    expect(readFileSync(join(corpus, 'lux.yaml'), 'utf8')).toBe('custom: owner-work\n');
  });

  it('rejects a target modified after staging but before rename', () => {
    const corpus = root();
    writeFileSync(join(corpus, 'lux.yaml'), 'old\n');
    const beforeHash = createHash('sha256').update('old\n').digest('hex');
    expect(() =>
      writeAtomicallyInsideRoot(corpus, 'lux.yaml', 'new\n', beforeHash, {
        beforeRename: () => writeFileSync(join(corpus, 'lux.yaml'), 'owner-race\n'),
      })
    ).toThrow(/hash mismatch/u);
    expect(readFileSync(join(corpus, 'lux.yaml'), 'utf8')).toBe('owner-race\n');
  });

  it('rejects traversal and symlink escapes', () => {
    const corpus = root();
    const outside = root();
    symlinkSync(join(outside, 'escaped.yaml'), join(corpus, 'lux.yaml'));
    expect(() => buildInitPlan(corpus)).toThrow(/symlink|ENOENT/u);
    expect(() => writeAtomicallyInsideRoot(corpus, '../escape', 'bad')).toThrow(/escapes/u);
    expect(existsSync(join(outside, 'escaped.yaml'))).toBe(false);
  });

  it('rolls back the first target when the second target commit is interrupted', () => {
    const corpus = root();
    writeFileSync(join(corpus, 'main.ts'), 'export {};\n');
    const plan = buildInitPlan(corpus);
    let commits = 0;
    expect(() =>
      applyInitPlan(plan, true, {
        beforeRename: () => {
          commits++;
          if (commits === 2) throw new Error('interrupted-second');
        },
      })
    ).toThrow('interrupted-second');
    expect(existsSync(join(corpus, 'lux.yaml'))).toBe(false);
    expect(existsSync(join(corpus, '.gitignore'))).toBe(false);
  });

  it('cleans its temporary file and preserves target on interrupted atomic write', () => {
    const corpus = root();
    writeFileSync(join(corpus, 'lux.yaml'), 'old\n');
    expect(() =>
      writeAtomicallyInsideRoot(
        corpus,
        'lux.yaml',
        'new\n',
        buildInitPlan(corpus).changes[0].beforeHash,
        {
          beforeRename: () => {
            throw new Error('interrupted');
          },
        }
      )
    ).toThrow('interrupted');
    expect(readFileSync(join(corpus, 'lux.yaml'), 'utf8')).toBe('old\n');
    expect(readdirSync(corpus).filter((name) => name.includes('.lux-init-'))).toEqual([]);
    expect(lstatSync(join(corpus, 'lux.yaml')).isFile()).toBe(true);
  });
});
