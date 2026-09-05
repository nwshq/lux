import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../../db/index.js';
import type { ScanResult } from '../../types.js';
import { rebuildStructuralOverlay } from '../overlay-service.js';

const roots: string[] = [];

function fixture(files: Record<string, string>): {
  root: string;
  scan: ScanResult;
  db: LuxDatabase;
} {
  const root = mkdtempSync(join(tmpdir(), 'lux-js-overlay-'));
  roots.push(root);
  const knowledge: ScanResult['knowledge'] = [];
  for (const [filePath, content] of Object.entries(files)) {
    const absolute = join(root, filePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
    const extension = filePath.slice(filePath.lastIndexOf('.'));
    knowledge.push({
      type: 'source-code',
      title: filePath,
      filePath: absolute,
      frontmatter: { language: 'javascript', extension },
      content,
    });
  }
  return { root, scan: { knowledge }, db: new LuxDatabase(join(root, 'test.db')) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded JavaScript overlay integration', () => {
  it('materializes JavaScript symbols and same-file calls for all four extensions', async () => {
    for (const extension of ['js', 'jsx', 'mjs', 'cjs']) {
      const fx = fixture({
        [`src/example.${extension}`]: 'function target() {}\nfunction caller() { target(); }\n',
      });
      const result = await rebuildStructuralOverlay(fx.db, fx.root, fx.scan, new Map(), {
        astEnabled: true,
        resolvers: undefined,
        detectors: [],
        operationalExtractors: [],
      });
      const nodes = fx.db.getStructuralNodesForFilePaths([`src/example.${extension}`]);
      const symbols = nodes.filter((node) => node.node_type === 'symbol');
      expect(symbols.map((node) => node.language_id)).toEqual(['javascript', 'javascript']);
      expect(symbols.every((node) => node.id.startsWith('symbol:ts:'))).toBe(true);
      const caller = symbols.find((node) => node.symbol_name === 'caller');
      expect(caller).toBeDefined();
      expect(fx.db.getOutgoingStructuralEdges(caller!.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edge_type: 'calls',
            target_node_id: `symbol:ts:src/example.${extension}#target`,
          }),
        ])
      );
      expect(result.programAnalysis?.facts[0]).toMatchObject({
        schemaVersion: 1,
        languageId: 'javascript',
        filePath: `src/example.${extension}`,
      });
      expect(result.programAnalysis?.producersRun.has('javascript-tree-sitter')).toBe(true);
      fx.db.close();
    }
  });

  it('isolates a parser limit without aborting valid files', async () => {
    const fx = fixture({
      'src/good.js': 'function good() {}\n',
      'src/oversized.js': `function huge() {}\n${' '.repeat(2 * 1024 * 1024)}`,
    });
    const warnings: string[] = [];
    const result = await rebuildStructuralOverlay(fx.db, fx.root, fx.scan, new Map(), {
      astEnabled: true,
      detectors: [],
      operationalExtractors: [],
      onProgress: (message) => warnings.push(message),
    });
    const good = fx.db.getStructuralNodesForFilePaths(['src/good.js']);
    const oversized = fx.db.getStructuralNodesForFilePaths(['src/oversized.js']);
    expect(good.some((node) => node.symbol_name === 'good')).toBe(true);
    expect(oversized.some((node) => node.node_type === 'symbol')).toBe(false);
    expect(result.programAnalysis?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'limit' })])
    );
    expect(warnings.some((message) => message.includes('maxBytes'))).toBe(true);
    fx.db.close();
  });
});
