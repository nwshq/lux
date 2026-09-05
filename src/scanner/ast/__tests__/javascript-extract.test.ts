import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type Parser from 'web-tree-sitter';
import {
  astLanguageId,
  extractSource,
  initGrammars,
  langForFile,
  type AstLang,
  type Extraction,
} from '../extract.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'javascript');
let grammars: Map<AstLang, Parser.Language>;

beforeAll(async () => {
  grammars = await initGrammars();
});

function fixture(name: string): Extraction {
  const lang = langForFile(name);
  if (!lang) throw new Error(`unsupported fixture: ${name}`);
  return extractSource(grammars, readFileSync(join(FIXTURES, name), 'utf8'), name, lang).extraction;
}

function fact(extraction: Extraction, kind: string, fields: Record<string, string> = {}) {
  return extraction.moduleFacts?.find(
    (candidate) =>
      candidate.kind === kind &&
      Object.entries(fields).every(
        ([key, value]) => candidate[key as keyof typeof candidate] === value
      )
  );
}

describe('JavaScript language routing', () => {
  it('maps all four JavaScript extensions case-insensitively and preserves other languages', () => {
    expect(langForFile('a.js')).toBe('javascript');
    expect(langForFile('a.JSX')).toBe('jsx');
    expect(langForFile('a.mjs')).toBe('javascript');
    expect(langForFile('a.CJS')).toBe('javascript');
    expect(langForFile('a.ts')).toBe('typescript');
    expect(langForFile('a.tsx')).toBe('tsx');
    expect(langForFile('a.php')).toBe('php');
    expect(langForFile('a.json')).toBeNull();
    expect(astLanguageId('javascript')).toBe('javascript');
    expect(astLanguageId('jsx')).toBe('javascript');
    expect(astLanguageId('typescript')).toBe('typescript');
    expect(astLanguageId('tsx')).toBe('typescript');
    expect(astLanguageId('php')).toBe('php');
  });
});

describe('JavaScript declarations and direct relationships', () => {
  it.each([
    [
      'declarations.js',
      [
        'declared',
        'Service',
        'run',
        'stop',
        'assignedArrow',
        'assignedFunction',
        'AssignedClass',
        'method',
        'reassignedArrow',
        'reassignedFunction',
        'ReassignedClass',
      ],
    ],
    ['declarations.jsx', ['Card', 'helper']],
    ['declarations.mjs', ['ModuleClass', 'start', 'helper', 'arrow']],
    ['declarations.cjs', ['factory', 'Legacy', 'build', 'assigned']],
  ])('extracts declarations from %s', (name, expected) => {
    const extraction = fixture(name);
    for (const symbol of expected) {
      expect(
        extraction.nodes.map((node) => node.name),
        `${name}:${symbol}`
      ).toContain(symbol);
    }
    expect(extraction.diagnostics, name).toEqual([]);
  });

  it('classifies bare, this, typed-member, and new edges with exact name ranges', () => {
    const extraction = fixture('declarations.js');
    expect(extraction.edges.find((edge) => edge.member === 'assignedArrow')?.callKind).toBe(
      'identifier'
    );
    expect(extraction.edges.find((edge) => edge.member === 'stop')?.callKind).toBe('this');
    expect(extraction.edges.find((edge) => edge.member === 'run')?.callKind).toBe('member');
    expect(
      extraction.edges.find((edge) => edge.type === 'new' && edge.toRaw === 'Service')
    ).toBeDefined();
    expect(
      extraction.edges.filter((edge) => edge.type !== 'import').every((edge) => edge.nameRange)
    ).toBe(true);
  });

  it('parses JSX nodes using the JavaScript grammar without adding JSX render semantics', () => {
    const extraction = fixture('declarations.jsx');
    expect(extraction.nodes.some((node) => node.name === 'Card')).toBe(true);
    expect(extraction.edges.some((edge) => edge.toRaw === 'helper')).toBe(true);
    expect(extraction.edges.some((edge) => edge.toRaw === 'section')).toBe(false);
  });
});

describe('ESM and CommonJS module facts', () => {
  it('extracts default and side-effect imports plus default export', () => {
    const extraction = fixture('esm-default.js');
    expect(
      fact(extraction, 'esm-import', {
        localName: 'defaultThing',
        importedName: 'default',
        specifier: './default-thing.js',
      })
    ).toBeDefined();
    expect(fact(extraction, 'esm-import', { specifier: './side-effect.js' })).toBeDefined();
    expect(
      fact(extraction, 'esm-export-default', { localName: 'primary', exportedName: 'default' })
    ).toBeDefined();
  });

  it('extracts default, named, namespace, local export, and literal dynamic import facts', () => {
    const extraction = fixture('esm-named.js');
    expect(
      fact(extraction, 'esm-import', { localName: 'base', importedName: 'default' })
    ).toBeDefined();
    expect(
      fact(extraction, 'esm-import', { localName: 'localAlpha', importedName: 'alpha' })
    ).toBeDefined();
    expect(
      fact(extraction, 'esm-import', { localName: 'beta', importedName: 'beta' })
    ).toBeDefined();
    expect(
      fact(extraction, 'esm-import', { localName: 'namespace', importedName: '*' })
    ).toBeDefined();
    expect(
      fact(extraction, 'esm-export-named', { localName: 'own', exportedName: 'own' })
    ).toBeDefined();
    expect(
      fact(extraction, 'esm-export-named', { localName: 'localAlpha', exportedName: 'alpha' })
    ).toBeDefined();
    expect(
      fact(extraction, 'esm-export-named', { localName: 'beta', exportedName: 'beta' })
    ).toBeDefined();
    expect(fact(extraction, 'esm-import', { specifier: './lazy.js' })).toBeDefined();
  });

  it('extracts named, all, and namespace re-exports', () => {
    const extraction = fixture('esm-reexport.js');
    expect(
      fact(extraction, 'esm-reexport-named', {
        importedName: 'first',
        exportedName: 'first',
        specifier: './source.js',
      })
    ).toBeDefined();
    expect(
      fact(extraction, 'esm-reexport-named', {
        importedName: 'second',
        exportedName: 'renamed',
        specifier: './source.js',
      })
    ).toBeDefined();
    expect(fact(extraction, 'esm-reexport-all', { specifier: './all.js' })).toBeDefined();
    expect(
      fact(extraction, 'esm-reexport-all', { exportedName: 'grouped', specifier: './grouped.js' })
    ).toBeDefined();
  });

  it('extracts default and side-effect CommonJS require plus module.exports', () => {
    const extraction = fixture('commonjs-default.cjs');
    expect(
      fact(extraction, 'commonjs-require', {
        localName: 'factory',
        importedName: 'default',
        specifier: './factory.cjs',
      })
    ).toBeDefined();
    expect(fact(extraction, 'commonjs-require', { specifier: './setup.cjs' })).toBeDefined();
    expect(
      fact(extraction, 'commonjs-module-exports', { localName: 'factory', exportedName: 'default' })
    ).toBeDefined();
  });

  it('extracts destructured require and both named CommonJS export spellings', () => {
    const extraction = fixture('commonjs-named.cjs');
    expect(
      fact(extraction, 'commonjs-require', { localName: 'first', importedName: 'first' })
    ).toBeDefined();
    expect(
      fact(extraction, 'commonjs-require', { localName: 'localSecond', importedName: 'second' })
    ).toBeDefined();
    expect(
      fact(extraction, 'commonjs-exports-member', { localName: 'first', exportedName: 'first' })
    ).toBeDefined();
    expect(
      fact(extraction, 'commonjs-exports-member', {
        localName: 'localSecond',
        exportedName: 'second',
      })
    ).toBeDefined();
  });

  it('puts syntax and exact local-token ranges on every import binding', () => {
    const extractions = [fixture('esm-named.js'), fixture('commonjs-named.cjs')];
    for (const extraction of extractions) {
      for (const binding of extraction.imports ?? []) {
        expect(binding.syntax).toMatch(/^(esm|commonjs)$/);
        expect(binding.range?.startLine).toBeGreaterThan(0);
        expect(binding.range?.endByte).toBeGreaterThan(binding.range?.startByte ?? -1);
      }
    }
  });
});

describe('dynamic and malformed module negatives', () => {
  it('diagnoses every unsupported dynamic form and emits no module target fact or edge', () => {
    const extraction = fixture('dynamic-negatives.js');
    expect(extraction.diagnostics).toHaveLength(10);
    expect(
      extraction.diagnostics?.every((item) => item.code === 'unsupported-dynamic-module')
    ).toBe(true);
    expect(extraction.diagnostics?.every((item) => item.range?.startLine)).toBe(true);

    const forbidden = [
      'target',
      'dynamicRequire',
      'dynamicImport',
      'literal-looking-computed',
      'moduleAlias',
      'exportsAlias',
      'named',
      "'module.exports = dynamicRequire'",
    ];
    for (const target of forbidden) {
      expect(
        extraction.edges.some((edge) => edge.type === 'import' && edge.toRaw === target),
        target
      ).toBe(false);
      expect(
        extraction.moduleFacts?.some((item) => item.specifier === target),
        target
      ).toBe(false);
    }
    expect(extraction.moduleFacts).toHaveLength(0);
    expect(extraction.edges.some((edge) => edge.toRaw === 'eval')).toBe(false);
  });

  it('retains recoverable facts and emits located parse diagnostics', () => {
    const extraction = fixture('malformed.js');
    expect(extraction.nodes.some((node) => node.name === 'valid')).toBe(true);
    expect(extraction.diagnostics?.some((item) => item.code === 'parse-error')).toBe(true);
    expect(
      extraction.diagnostics?.find((item) => item.code === 'parse-error')?.range
    ).toBeDefined();
  });
});
