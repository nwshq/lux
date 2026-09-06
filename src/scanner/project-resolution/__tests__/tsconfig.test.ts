import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseTsconfigAliases } from '../tsconfig.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  config: unknown,
  name = 'tsconfig.json'
): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lux-tsconfig-'));
  cleanup.push(root);
  await mkdir(join(root, 'src', 'exact'), { recursive: true });
  const file = join(root, name);
  await writeFile(file, typeof config === 'string' ? config : JSON.stringify(config));
  return { root, file };
}

describe('ts/jsconfig aliases', () => {
  it('emits exact rules before one-star rules ordered by longest literal prefix', async () => {
    const { root, file } = await fixture({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@exact': ['src/exact'],
          '@/*': ['src/*'],
          '@features/*': ['src/features/*'],
        },
      },
    });
    const sources = new Set(['src/exact/index.ts', 'src/value.ts', 'src/features/value.ts']);
    const result = await parseTsconfigAliases([file], root, [root], sources);
    expect(result.rules.map((rule) => rule.pattern)).toEqual(['@exact', '@features/*', '@/*']);
    expect(result.rules[0]).toMatchObject({
      source: 'tsconfig',
      targets: ['src/exact/index.ts'],
      configFile: file,
    });
  });

  it('preserves wildcard templates and rejects zero-source targets', async () => {
    const { root, file } = await fixture({
      compilerOptions: {
        paths: {
          '@ok/*': ['src/features/*'],
          '@missing/*': ['missing/*'],
        },
      },
    });
    const result = await parseTsconfigAliases([file], root, [root], new Set(['src/features/a.ts']));
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].targets).toEqual(['src/features/*']);
    expect(result.diagnostics.map((item) => item.code)).toContain('tsconfig-alias-target-missing');
  });

  it('retains all existing exact targets and diagnoses ambiguity', async () => {
    const { root, file } = await fixture({
      compilerOptions: { paths: { '@multi': ['src/one', 'src/two'] } },
    });
    const result = await parseTsconfigAliases(
      [file],
      root,
      [root],
      new Set(['src/one.ts', 'src/two.ts'])
    );
    expect(result.rules[0].targets).toEqual(['src/one.ts', 'src/two.ts']);
    expect(result.diagnostics.map((item) => item.code)).toContain('tsconfig-alias-ambiguous');
  });

  it('resolves baseUrl relative to the declaring extended config and tracks every read', async () => {
    const { root, file } = await fixture({ extends: './config/base.json' });
    await mkdir(join(root, 'config'));
    await writeFile(
      join(root, 'config', 'base.json'),
      '{ // inherited JSONC\n "compilerOptions": {"baseUrl":"..", "paths":{"@base":["src/exact"]},},\n}'
    );
    const result = await parseTsconfigAliases(
      [file],
      root,
      [root],
      new Set(['src/exact/index.ts'])
    );
    expect(result.rules[0]).toMatchObject({
      pattern: '@base',
      targets: ['src/exact/index.ts'],
      configFile: join(root, 'config', 'base.json'),
    });
    expect(result.dependencies).toEqual([join(root, 'config', 'base.json'), file]);
  });

  it('lets child paths replace inherited paths with the same pattern', async () => {
    const { root, file } = await fixture({
      extends: './base.json',
      compilerOptions: { paths: { '@value': ['src/child'] } },
    });
    await writeFile(
      join(root, 'base.json'),
      JSON.stringify({ compilerOptions: { paths: { '@value': ['src/parent'] } } })
    );
    const result = await parseTsconfigAliases(
      [file],
      root,
      [root],
      new Set(['src/parent.ts', 'src/child.ts'])
    );
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].targets).toEqual(['src/child.ts']);
  });

  it.each([
    ['../../outside', 'tsconfig-baseurl-escape'],
    ['/absolute', 'tsconfig-baseurl-invalid'],
    ['https://example.invalid', 'tsconfig-baseurl-invalid'],
  ])('rejects baseUrl %j', async (baseUrl, code) => {
    const { root, file } = await fixture({
      compilerOptions: { baseUrl, paths: { '@escape': ['file'] } },
    });
    const result = await parseTsconfigAliases([file], root, [root], new Set(['file.ts']));
    expect(result.rules).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(code);
  });

  it.each([
    ['@two/**', 'src/**'],
    ['@mismatch/*', 'src/value'],
    ['@absolute', '/tmp/value'],
    ['@escape', '../../value'],
    ['@control', 'src/line\nfeed'],
  ])('rejects unsupported or escaping mapping %j -> %j', async (pattern, target) => {
    const { root, file } = await fixture({
      compilerOptions: { paths: { [pattern]: [target] } },
    });
    const result = await parseTsconfigAliases([file], root, [root], new Set(['value.ts']));
    expect(result.rules).toEqual([]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('labels jsconfig rules and refuses package extends without opening it', async () => {
    const { root, file } = await fixture(
      {
        extends: '@scope/config',
        compilerOptions: { paths: { '@js': ['src/exact'] } },
      },
      'jsconfig.json'
    );
    const result = await parseTsconfigAliases(
      [file],
      root,
      [root],
      new Set(['src/exact/index.js'])
    );
    expect(result.rules[0].source).toBe('jsconfig');
    expect(result.dependencies).toEqual([file]);
    expect(result.diagnostics.map((item) => item.code)).toContain('tsconfig-extends-external');
  });
});
