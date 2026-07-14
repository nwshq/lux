import { describe, it, expect, beforeAll } from 'vitest';
import type Parser from 'web-tree-sitter';
import { initGrammars, extractSource, langForFile, type AstLang } from '../extract.js';

let grammars: Map<AstLang, Parser.Language>;

beforeAll(async () => {
  grammars = await initGrammars();
});

describe('langForFile', () => {
  it('maps supported extensions and rejects others', () => {
    expect(langForFile('a.ts')).toBe('typescript');
    expect(langForFile('a.tsx')).toBe('tsx');
    expect(langForFile('a.php')).toBe('php');
    expect(langForFile('a.md')).toBeNull();
    expect(langForFile('a.go')).toBeNull();
  });
});

describe('extractSource — TypeScript', () => {
  it('extracts definitions, imports, and resolves same-file calls only', () => {
    const src = [
      "import { helper } from './helper.js';",
      'export function doThing() {',
      '  return helper();',
      '}',
      'class Widget {',
      '  render() {',
      '    return doThing();',
      '  }',
      '}',
      'const w = new Widget();',
    ].join('\n');

    const { extraction, hadError } = extractSource(grammars, src, 'sample.ts', 'typescript');

    expect(hadError).toBe(false);
    const names = extraction.nodes.map((n) => `${n.type}:${n.name}`);
    expect(names).toContain('function:doThing');
    expect(names).toContain('class:Widget');
    expect(names).toContain('method:render');

    // import edge captured with the module specifier
    expect(extraction.edges.some((e) => e.type === 'import' && e.toRaw === './helper.js')).toBe(
      true
    );

    // local call resolves same-file; imported call stays unresolved (arm-D's job)
    const doThingCall = extraction.edges.find((e) => e.type === 'call' && e.toRaw === 'doThing');
    expect(doThingCall?.resolvedSameFile).toBe(true);
    const helperCall = extraction.edges.find((e) => e.type === 'call' && e.toRaw === 'helper');
    expect(helperCall).toBeDefined();
    expect(helperCall?.resolvedSameFile).toBeUndefined();

    // construction edge
    expect(extraction.edges.some((e) => e.type === 'new' && e.toRaw === 'Widget')).toBe(true);
  });
});

describe('extractSource — PHP', () => {
  it('extracts classes, methods, use-imports, and same-file method calls', () => {
    const src = [
      '<?php',
      'namespace App\\Billing;',
      'use App\\Support\\Money;',
      'class Ledger {',
      '  public function total(): int {',
      '    return $this->compute();',
      '  }',
      '  private function compute(): int {',
      '    return 0;',
      '  }',
      '}',
    ].join('\n');

    const { extraction } = extractSource(grammars, src, 'Ledger.php', 'php');

    const names = extraction.nodes.map((n) => `${n.type}:${n.name}`);
    expect(names).toContain('class:Ledger');
    expect(names).toContain('method:total');
    expect(names).toContain('method:compute');

    expect(extraction.edges.some((e) => e.type === 'import' && e.toRaw.includes('Money'))).toBe(
      true
    );
    // `$this->compute()` is classified as a `this` call carrying the method leaf
    // and a nameRange (for LSP); the same-file resolution to Ledger::compute is
    // proven at the resolver level (see resolver.test.ts), not here.
    const computeCall = extraction.edges.find((e) => e.type === 'call' && e.member === 'compute');
    expect(computeCall?.callKind).toBe('this');
    expect(computeCall?.nameRange).toBeDefined();
    expect(computeCall?.resolvedSameFile).toBeUndefined();
  });
});

describe('extractSource — typed-receiver classification', () => {
  it('marks PHP $obj->method() as a member call carrying a nameRange for LSP', () => {
    const src = [
      '<?php',
      'class Svc {',
      '  function run() {',
      '    $this->repo->find();', // typed receiver ($this->repo), not $this directly
      '    Other::make();',
      '  }',
      '}',
    ].join('\n');
    const { extraction } = extractSource(grammars, src, 'Svc.php', 'php');
    const find = extraction.edges.find((e) => e.type === 'call' && e.member === 'find');
    expect(find?.callKind).toBe('member');
    expect(find?.nameRange).toBeDefined(); // without this, the LSP typed-receiver pass skips it
    const make = extraction.edges.find((e) => e.type === 'call' && e.member === 'make');
    expect(make?.callKind).toBe('member'); // Foo::bar() static call -> typed, LSP
    expect(make?.nameRange).toBeDefined();
  });

  it('classifies PHP nullsafe calls ($this?->m as this, $obj?->m as member)', () => {
    const src = [
      '<?php',
      'class C {',
      '  function run() {',
      '    $this?->help();',
      '    $obj?->go();',
      '  }',
      '  function help() {}',
      '}',
    ].join('\n');
    const { extraction } = extractSource(grammars, src, 'C.php', 'php');
    expect(extraction.edges.find((e) => e.type === 'call' && e.member === 'help')?.callKind).toBe(
      'this'
    );
    const go = extraction.edges.find((e) => e.type === 'call' && e.member === 'go');
    expect(go?.callKind).toBe('member');
    expect(go?.nameRange).toBeDefined();
  });

  it('classifies TS member vs this vs bare calls', () => {
    const src = [
      'class C {',
      '  m(dep: D) {',
      '    this.m(dep);', // this
      '    dep.go();', // member (typed receiver)
      '    bare();', // identifier
      '  }',
      '}',
      'function bare() {}',
    ].join('\n');
    const { extraction } = extractSource(grammars, src, 'c.ts', 'typescript');
    const kindOf = (member: string) =>
      extraction.edges.find((e) => e.type === 'call' && e.member === member)?.callKind;
    expect(kindOf('m')).toBe('this');
    expect(kindOf('go')).toBe('member');
    expect(kindOf('bare')).toBe('identifier');
  });
});

describe('extractSource — error tolerance', () => {
  it('still extracts from a partial parse and flags hadError', () => {
    const { extraction, hadError } = extractSource(
      grammars,
      'function ok() {}\nfunction broken( {',
      'broken.ts',
      'typescript'
    );
    expect(hadError).toBe(true);
    expect(extraction.nodes.some((n) => n.name === 'ok')).toBe(true);
  });
});
