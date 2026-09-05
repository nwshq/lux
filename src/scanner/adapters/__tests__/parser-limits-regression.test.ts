import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PARSER_LIMITS, type ParserLimitsV1 } from '../types.js';
import type { AdapterWorkerRequestV1 } from '../worker-protocol.js';
import { runAdapterWorker } from '../worker-host.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'lux-parser-limit-'));
  roots.push(path);
  return path;
}

function request(
  path: string,
  file: string,
  limits: Partial<ParserLimitsV1>
): AdapterWorkerRequestV1 {
  return {
    schemaVersion: 1,
    adapterId: 'tree-sitter',
    input: {
      corpusRoot: path,
      allowedRoots: [path],
      filePath: file,
      limits: { ...DEFAULT_PARSER_LIMITS, ...limits },
    },
  };
}

function nestedSource(extension: string, levels: number): string {
  if (extension === '.php')
    return `<?php\nfunction deep() { return ${'('.repeat(levels)}1${')'.repeat(levels)}; }`;
  return `export function deep() { return ${'('.repeat(levels)}1${')'.repeat(levels)}; }`;
}

function referencesSource(extension: string, count: number): string {
  if (extension === '.php') {
    return `<?php\nfunction refs() {\n${Array.from({ length: count }, () => 'target();').join('\n')}\n}`;
  }
  return `function refs() {\n${Array.from({ length: count }, () => 'target();').join('\n')}\n}`;
}

function nodesSource(extension: string, count: number): string {
  const declarations = Array.from(
    { length: count },
    (_, index) => `function n${index}() { return ${index}; }`
  ).join('\n');
  return extension === '.php' ? `<?php\n${declarations}` : `export { };\n${declarations}`;
}

async function runSource(
  extension: '.ts' | '.php',
  source: string,
  limits: Partial<ParserLimitsV1>
) {
  const path = await root();
  const file = join(path, `case${extension}`);
  await writeFile(file, source);
  return runAdapterWorker(request(path, file, limits));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('default hostile ceilings', () => {
  it('rejects more than 100,000 named syntax nodes', async () => {
    const result = await runSource('.ts', `export {};\n${'x;\n'.repeat(50_001)}`, {});

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic).toMatchObject({ code: 'limit' });
    expect(!result.ok && result.diagnostic.message).toContain('maxNodes');
  });

  it('rejects more than 10,000 emitted references', async () => {
    const result = await runSource('.ts', referencesSource('.ts', 10_001), {});

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic).toMatchObject({ code: 'limit' });
    expect(!result.ok && result.diagnostic.message).toContain('maxReferences');
  });

  it('rejects syntax deeper than 128 named nodes', async () => {
    const result = await runSource('.ts', nestedSource('.ts', 160), {});

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic.message).toContain('maxDepth');
  });
});

describe.each(['.ts', '.php'] as const)('%s parser safety regression', (extension) => {
  it('accepts the exact byte boundary and rejects boundary + 1', async () => {
    const base = extension === '.php' ? '<?php ' : 'export { }; ';
    const maxBytes = Buffer.byteLength(base) + 64;
    const exact = base + ' '.repeat(64);
    const accepted = await runSource(extension, exact, { maxBytes });
    const rejected = await runSource(extension, `${exact} `, { maxBytes });

    expect(accepted.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.diagnostic.code).toBe('limit');
  });

  it('rejects depth over the configured boundary', async () => {
    const shallow = await runSource(extension, nestedSource(extension, 8), { maxDepth: 128 });
    const deep = await runSource(extension, nestedSource(extension, 160), { maxDepth: 128 });

    expect(shallow.ok).toBe(true);
    expect(deep.ok).toBe(false);
    expect(!deep.ok && deep.diagnostic).toMatchObject({ code: 'limit' });
    expect(!deep.ok && deep.diagnostic.message).toContain('maxDepth');
  });

  it('rejects named node count over the configured boundary', async () => {
    const accepted = await runSource(extension, nodesSource(extension, 8), { maxNodes: 100 });
    const rejected = await runSource(extension, nodesSource(extension, 100), { maxNodes: 100 });

    expect(accepted.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.diagnostic.message).toContain('maxNodes');
  });

  it('accepts maxReferences and rejects maxReferences + 1', async () => {
    const accepted = await runSource(extension, referencesSource(extension, 10), {
      maxReferences: 10,
    });
    const rejected = await runSource(extension, referencesSource(extension, 11), {
      maxReferences: 10,
    });

    expect(accepted.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    expect(!rejected.ok && rejected.diagnostic.message).toContain('maxReferences');
  });

  it('returns stable parse-error for malformed source', async () => {
    const malformed =
      extension === '.php' ? '<?php function broken( {' : 'export function broken( {';
    const result = await runSource(extension, malformed, {});

    expect(result.ok).toBe(true);
    expect(result.ok && result.output.facts.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'parse-error' })])
    );
  });

  it('returns language-correct PHP/TypeScript facts for valid source', async () => {
    const source =
      extension === '.php'
        ? '<?php class Example { function run() {} }'
        : 'export class Example { run() {} }';
    const result = await runSource(extension, source, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.facts.languageId).toBe(extension === '.php' ? 'php' : 'typescript');
      expect(extname(result.output.facts.filePath)).toBe(extension);
      expect(result.output.facts.declarations.map((item) => item.name)).toEqual(
        expect.arrayContaining(['Example', 'run'])
      );
    }
  });
});
