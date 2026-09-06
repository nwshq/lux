import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseViteAliases } from '../vite-alias.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string, name = 'vite.config.js') {
  const root = await mkdtemp(join(tmpdir(), 'lux-vite-alias-'));
  cleanup.push(root);
  await mkdir(join(root, 'src', 'features'), { recursive: true });
  await mkdir(join(root, 'resources', 'js'), { recursive: true });
  const file = join(root, name);
  await writeFile(file, source);
  return { root, file };
}

async function parse(source: string, sources = new Set(['src/index.ts', 'src/features/a.ts'])) {
  const item = await fixture(source);
  return {
    ...item,
    result: await parseViteAliases([item.file], item.root, [item.root], sources),
  };
}

describe('static Vite aliases', () => {
  it('accepts object aliases, literal constants, shorthand, and whitelisted path calls', async () => {
    const { file, result } = await parse(`
      import { resolve } from 'node:path';
      const projectRoot = process.cwd();
      const alias = {
        '@': resolve(projectRoot, 'src'),
        '@features': path.join(__dirname, 'src', 'features'),
      };
      export default defineConfig({ resolve: { alias } });
    `);
    expect(result.rules).toEqual([
      expect.objectContaining({
        pattern: '@',
        targets: ['src'],
        source: 'vite',
        configFile: file,
        precedence: 20_000,
      }),
      expect.objectContaining({ pattern: '@features', targets: ['src/features'] }),
    ]);
    expect(result.dependencies).toEqual([file]);
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts ordered array form and import.meta.dirname', async () => {
    const { result } = await parse(`
      export default {
        resolve: { alias: [
          { find: '@first', replacement: join(import.meta.dirname, 'src') },
          { find: '@second', replacement: path.resolve(process.cwd(), 'src/features') },
        ] }
      };
    `);
    expect(result.rules.map((rule) => [rule.pattern, rule.precedence])).toEqual([
      ['@first', 20_000],
      ['@second', 20_001],
    ]);
  });

  it('traverses defineConfig arrow syntax without invoking the callback', async () => {
    const { result } = await parse(`
      export default defineConfig(() => ({ resolve: { alias: { '@': resolve(__dirname, 'src') } } }));
    `);
    expect(result.rules.map((rule) => rule.pattern)).toEqual(['@']);
  });

  it('never executes or imports a config module', async () => {
    const item = await fixture(`
      import 'data:text/javascript,throw new Error("executed")';
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(tmpdir(), 'lux-vite-MUST-NOT-EXIST'))}, 'executed');
      throw new Error('executed');
      export default { resolve: { alias: { '@': './src' } } };
    `);
    const sentinel = join(tmpdir(), 'lux-vite-MUST-NOT-EXIST');
    await rm(sentinel, { force: true });
    const result = await parseViteAliases(
      [item.file],
      item.root,
      [item.root],
      new Set(['src/index.ts'])
    );
    await expect(access(sentinel)).rejects.toThrow();
    // Statements outside the export are ignored as inert AST data.
    expect(result.rules.map((rule) => rule.pattern)).toEqual(['@']);
  });

  it.each([
    ['process.env.ROOT', 'environment read'],
    ['getRoot()', 'arbitrary function'],
    ["condition ? './src' : './resources/js'", 'conditional'],
    ['`./${name}`', 'template substitution'],
    ["{ ...shared, '@': './src' }", 'spread'],
  ])('rejects %s (%s)', async (replacement, _label) => {
    const { result } = await parse(`
      const condition = true;
      const shared = {};
      export default { resolve: { alias: { '@': ${replacement} } } };
    `);
    expect(result.rules).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('vite-alias-dynamic');
  });

  it('rejects regex find, computed keys, and extra alias entry properties', async () => {
    const cases = [
      `export default { resolve: { alias: [{ find: /^@/, replacement: './src' }] } }`,
      `export default { resolve: { alias: { ['@']: './src' } } }`,
      `export default { resolve: { alias: [{ find: '@', replacement: './src', customResolver() {} }] } }`,
    ];
    for (const source of cases) {
      const { result } = await parse(source);
      expect(result.rules).toEqual([]);
      expect(result.diagnostics.map((item) => item.code)).toContain('vite-alias-dynamic');
    }
  });

  it('ignores plugins without executing them while retaining an independent static alias', async () => {
    const { result } = await parse(`
      export default { plugins: [dangerousPlugin()], resolve: { alias: { '@': './src' } } };
    `);
    expect(result.rules.map((rule) => rule.pattern)).toEqual(['@']);
    expect(result.diagnostics.map((item) => item.code)).toContain('vite-alias-dynamic');
  });

  it.each([
    ["'/tmp/outside'", 'absolute outside'],
    ["resolve(__dirname, '..', 'outside')", 'relative traversal'],
    ["'../outside'", 'plain relative traversal'],
  ])('rejects %s (%s) as a path escape', async (replacement, _label) => {
    const { result } = await parse(
      `export default { resolve: { alias: { '@': ${replacement} } } };`,
      new Set(['/tmp/outside.ts', 'outside.ts'])
    );
    expect(result.rules).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('vite-alias-path-escape');
  });

  it('rejects control-character alias strings and missing scanned targets', async () => {
    const { result } = await parse(`
      export default { resolve: { alias: { '@\\n': './src', '@missing': './absent' } } };
    `);
    expect(result.rules).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['vite-alias-dynamic', 'vite-alias-target-missing'])
    );
  });

  it('refuses symlinked Vite configs before the worker reads them', async () => {
    const item = await fixture('export default {}', 'real.config.js');
    const link = join(item.root, 'vite.config.js');
    await symlink(item.file, link);
    const result = await parseViteAliases([link], item.root, [item.root], new Set());
    expect(result.dependencies).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(['vite-alias-path-escape']);
  });

  it('reports malformed and non-static exports without rules', async () => {
    for (const source of ['export default { resolve: { alias:', 'export default buildConfig();']) {
      const { result } = await parse(source);
      expect(result.rules).toEqual([]);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });
});
