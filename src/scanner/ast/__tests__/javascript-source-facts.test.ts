import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type Parser from 'web-tree-sitter';
import { extractSource, initGrammars, langForFile, type AstLang } from '../extract.js';
import { extractionToSourceFacts } from '../source-facts.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'javascript');
let grammars: Map<AstLang, Parser.Language>;

beforeAll(async () => {
  grammars = await initGrammars();
});

function facts(name: string) {
  const lang = langForFile(name);
  if (!lang) throw new Error(`unsupported fixture: ${name}`);
  const extraction = extractSource(
    grammars,
    readFileSync(join(FIXTURES, name), 'utf8'),
    name,
    lang
  ).extraction;
  return extractionToSourceFacts(name, lang, extraction);
}

describe('extractionToSourceFacts — JavaScript', () => {
  it.each(['declarations.js', 'declarations.jsx', 'declarations.mjs', 'declarations.cjs'])(
    'labels %s as JavaScript while preserving file identity',
    (name) => {
      const result = facts(name);
      expect(result.schemaVersion).toBe(1);
      expect(result.filePath).toBe(name);
      expect(result.languageId).toBe('javascript');
      expect(result.declarations.length).toBeGreaterThan(0);
    }
  );

  it('uses stable local IDs for declarations and enclosing call attribution', () => {
    const result = facts('declarations.js');
    expect(result.declarations.find((item) => item.name === 'run')?.localId).toBe('Service.run');
    expect(result.declarations.find((item) => item.name === 'run')?.container).toBe('Service');
    expect(
      result.references.find(
        (item) => item.rawTarget === 'this.stop' && item.fromLocalId === 'Service.run'
      )
    ).toBeDefined();
    expect(
      result.references.find((item) => item.rawTarget === 'Service' && item.kind === 'reference')
    ).toBeDefined();
  });

  it('converts module facts before direct relationships with exact line/columns', () => {
    const result = facts('esm-default.js');
    const imported = result.references.find(
      (item) => item.kind === 'import' && item.rawTarget === './default-thing.js'
    );
    expect(imported).toMatchObject({
      fromLocalId: 'file:esm-default.js',
      member: 'default',
      location: { filePath: 'esm-default.js', line: 1, column: 7 },
    });
    const exported = result.references.find(
      (item) => item.kind === 'export' && item.rawTarget === 'default'
    );
    expect(exported?.location).toEqual({ filePath: 'esm-default.js', line: 3, column: 0 });
    expect(result.references[0]?.kind).toBe('import');
  });

  it('converts ESM re-export member and specifier fields exactly', () => {
    const result = facts('esm-reexport.js');
    expect(
      result.references.find((item) => item.rawTarget === './source.js' && item.member === 'second')
    ).toMatchObject({ kind: 'export', fromLocalId: 'file:esm-reexport.js' });
    expect(result.references.some((item) => item.rawTarget === './all.js')).toBe(true);
    expect(result.references.some((item) => item.rawTarget === './grouped.js')).toBe(true);
  });

  it('converts CommonJS import/export facts without inventing dynamic targets', () => {
    const result = facts('commonjs-named.cjs');
    expect(
      result.references.find(
        (item) =>
          item.kind === 'import' && item.rawTarget === './members.cjs' && item.member === 'second'
      )
    ).toBeDefined();
    expect(
      result.references.find((item) => item.kind === 'export' && item.rawTarget === 'second')
    ).toBeDefined();

    const dynamic = facts('dynamic-negatives.js');
    expect(dynamic.references).toHaveLength(1); // Object.assign remains a typed-member call candidate.
    expect(dynamic.references[0]).toMatchObject({ kind: 'call', rawTarget: 'Object.assign' });
    expect(dynamic.references.some((item) => item.kind === 'import')).toBe(false);
    expect(dynamic.references.some((item) => item.kind === 'export')).toBe(false);
  });

  it('converts every extraction diagnostic and preserves its location', () => {
    const result = facts('dynamic-negatives.js');
    expect(result.diagnostics).toHaveLength(10);
    expect(result.diagnostics.every((item) => item.code === 'unsupported-dynamic-module')).toBe(
      true
    );
    expect(result.diagnostics.map((item) => item.location?.line)).toEqual([
      2, 3, 4, 5, 7, 9, 10, 11, 12, 13,
    ]);
    expect(
      result.diagnostics.every((item) => item.location?.filePath === 'dynamic-negatives.js')
    ).toBe(true);
  });

  it('preserves parser-error diagnostics while retaining recoverable declarations', () => {
    const result = facts('malformed.js');
    expect(result.declarations.some((item) => item.name === 'valid')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'parse-error')).toBe(true);
    expect(
      result.diagnostics.find((item) => item.code === 'parse-error')?.location?.line
    ).toBeGreaterThan(0);
  });
});
