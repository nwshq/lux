import { describe, it, expect } from 'vitest';
import { AstStructuralResolver } from '../resolver.js';
import type { AssociationContext } from '../../associations/types.js';

function ctx(filePath: string, content: string): AssociationContext {
  return {
    rootPath: '/repo',
    nodes: [],
    entries: [{ filePath, metadata: { content } }],
    dirtyFiles: [],
  };
}

describe('AstStructuralResolver — same-file edges (Phase 3a)', () => {
  it('emits a calls edge from the enclosing method to a same-file function', async () => {
    const content = [
      'export function doThing() {}',
      'class Widget {',
      '  render() {',
      '    doThing();',
      '  }',
      '}',
    ].join('\n');
    const resolver = new AstStructuralResolver();
    const context = ctx('/repo/a/b.ts', content);

    expect(resolver.supports(context)).toBe(true);
    const edges = await resolver.resolve(context);

    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call).toBeDefined();
    expect(call?.sourceNodeId).toBe('symbol:ts:a/b.ts#Widget.render');
    expect(call?.targetNodeId).toBe('symbol:ts:a/b.ts#doThing');
    expect(call?.confidenceClass).toBe('framework-inferred');
    expect(call?.provenance.resolver).toBe('ast-structural');
  });

  it('emits a references edge for same-file construction', async () => {
    const content = ['class Widget {}', 'function make() {', '  return new Widget();', '}'].join(
      '\n'
    );
    const edges = await new AstStructuralResolver().resolve(ctx('/repo/x.ts', content));
    const ref = edges.find((e) => e.edgeType === 'references');
    expect(ref?.sourceNodeId).toBe('symbol:ts:x.ts#make');
    expect(ref?.targetNodeId).toBe('symbol:ts:x.ts#Widget');
  });

  it('leaves cross-file (imported) calls for the LSP-resolve step', async () => {
    const content = [
      "import { helper } from './h.js';",
      'function go() {',
      '  helper();',
      '}',
    ].join('\n');
    const edges = await new AstStructuralResolver().resolve(ctx('/repo/c.ts', content));
    expect(edges.filter((e) => e.edgeType === 'calls')).toHaveLength(0);
  });

  it('resolves PHP same-file method calls with namespace-qualified ids', async () => {
    const content = [
      '<?php',
      'namespace App\\Billing;',
      'class Ledger {',
      '  public function total() {',
      '    return $this->compute();',
      '  }',
      '  private function compute() {',
      '    return 0;',
      '  }',
      '}',
    ].join('\n');
    const edges = await new AstStructuralResolver().resolve(ctx('/repo/Ledger.php', content));
    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call?.sourceNodeId).toBe('symbol:php:App\\Billing\\Ledger::total');
    expect(call?.targetNodeId).toBe('symbol:php:App\\Billing\\Ledger::compute');
  });
});

describe('AstStructuralResolver — import-bound cross-file edges (Step 1)', () => {
  function multiCtx(files: Array<{ filePath: string; content: string }>): AssociationContext {
    return {
      rootPath: '/repo',
      nodes: [],
      entries: files.map((f) => ({ filePath: f.filePath, metadata: { content: f.content } })),
      dirtyFiles: [],
    };
  }

  it('resolves a TS call to a directly-imported function in another file', async () => {
    const context = multiCtx([
      {
        filePath: '/repo/src/a.ts',
        content: ["import { helper } from './b.js';", 'function go() {', '  helper();', '}'].join(
          '\n'
        ),
      },
      { filePath: '/repo/src/b.ts', content: 'export function helper() {}' },
    ]);
    const edges = await new AstStructuralResolver().resolve(context);
    const call = edges.find(
      (e) => e.edgeType === 'calls' && e.sourceNodeId === 'symbol:ts:src/a.ts#go'
    );
    expect(call).toBeDefined();
    expect(call?.targetNodeId).toBe('symbol:ts:src/b.ts#helper');
    expect(call?.confidenceClass).toBe('framework-inferred');
  });

  it('resolves a TS `new` of an imported class in another file', async () => {
    const context = multiCtx([
      {
        filePath: '/repo/x.ts',
        content: [
          "import { Widget } from './w.js';",
          'function make() {',
          '  return new Widget();',
          '}',
        ].join('\n'),
      },
      { filePath: '/repo/w.ts', content: 'export class Widget {}' },
    ]);
    const edges = await new AstStructuralResolver().resolve(context);
    const ref = edges.find(
      (e) => e.edgeType === 'references' && e.sourceNodeId === 'symbol:ts:x.ts#make'
    );
    expect(ref?.targetNodeId).toBe('symbol:ts:w.ts#Widget');
  });

  it('resolves a PHP `new` of a used class in another file (by FQN)', async () => {
    const context = multiCtx([
      {
        filePath: '/repo/Service.php',
        content: [
          '<?php',
          'namespace App;',
          'use App\\Support\\Money;',
          'class Service {',
          '  public function run() {',
          '    return new Money();',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        filePath: '/repo/Support/Money.php',
        content: ['<?php', 'namespace App\\Support;', 'class Money {}'].join('\n'),
      },
    ]);
    const edges = await new AstStructuralResolver().resolve(context);
    const ref = edges.find((e) => e.edgeType === 'references');
    expect(ref?.sourceNodeId).toBe('symbol:php:App\\Service::run');
    expect(ref?.targetNodeId).toBe('symbol:php:App\\Support\\Money');
  });

  it('does not emit an edge to an unscanned (external) target', async () => {
    const context = multiCtx([
      {
        filePath: '/repo/c.ts',
        content: [
          "import { missing } from './gone.js';",
          'function go() {',
          '  missing();',
          '}',
        ].join('\n'),
      },
    ]);
    const edges = await new AstStructuralResolver().resolve(context);
    expect(edges.filter((e) => e.edgeType === 'calls')).toHaveLength(0);
  });
});

describe('AstStructuralResolver — receiver-aware resolution (no false edges)', () => {
  function multiCtx(files: Array<{ filePath: string; content: string }>): AssociationContext {
    return {
      rootPath: '/repo',
      nodes: [],
      entries: files.map((f) => ({ filePath: f.filePath, metadata: { content: f.content } })),
      dirtyFiles: [],
    };
  }

  it('does NOT resolve a member call to a same-file function sharing the method name', async () => {
    // `date.format()` is a method on the `date` receiver — it must not be
    // misattributed to the same-file free function `format()`.
    const content = [
      'export function format(x: string) { return x; }',
      'class Report {',
      '  render(date: Date) {',
      '    return date.format();',
      '  }',
      '}',
    ].join('\n');
    const edges = await new AstStructuralResolver().resolve(ctx('/repo/a.ts', content));
    expect(
      edges.some((e) => e.targetNodeId === 'symbol:ts:a.ts#format' && e.edgeType === 'calls')
    ).toBe(false);
    expect(edges.filter((e) => e.edgeType === 'calls')).toHaveLength(0);
  });

  it('resolves this.method() to the ENCLOSING class, not the first class of that name', async () => {
    const content = [
      'class A { foo() {} }',
      'class B {',
      '  foo() {}',
      '  bar() { this.foo(); }',
      '}',
    ].join('\n');
    const edges = await new AstStructuralResolver().resolve(ctx('/repo/x.ts', content));
    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call?.sourceNodeId).toBe('symbol:ts:x.ts#B.bar');
    expect(call?.targetNodeId).toBe('symbol:ts:x.ts#B.foo'); // NOT A.foo
  });

  it('does NOT bind a member call to an imported name sharing the method name', async () => {
    // `date.format()` where `format` is imported: the import is the symbol
    // `format`, not the `.format()` member on `date`.
    const context = multiCtx([
      {
        filePath: '/repo/c.ts',
        content: [
          "import { format } from './m.js';",
          'function render(date: Date) {',
          '  return date.format();',
          '}',
        ].join('\n'),
      },
      { filePath: '/repo/m.ts', content: 'export function format() {}' },
    ]);
    const edges = await new AstStructuralResolver().resolve(context);
    expect(edges.some((e) => e.targetNodeId === 'symbol:ts:m.ts#format')).toBe(false);
  });

  it('still resolves a genuine bare same-file call (regression guard)', async () => {
    const content = ['function helper() {}', 'function go() { helper(); }'].join('\n');
    const edges = await new AstStructuralResolver().resolve(ctx('/repo/a.ts', content));
    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call?.sourceNodeId).toBe('symbol:ts:a.ts#go');
    expect(call?.targetNodeId).toBe('symbol:ts:a.ts#helper');
  });

  it('resolves PHP $this->method() to the same class but not $other->method()', async () => {
    const content = [
      '<?php',
      'namespace App;',
      'class Svc {',
      '  public function run() {',
      '    $this->help();', // same-class -> resolves
      '    $other->help();', // typed receiver -> LSP, not same-file
      '  }',
      '  private function help() {}',
      '}',
    ].join('\n');
    const edges = await new AstStructuralResolver().resolve(ctx('/repo/Svc.php', content));
    const calls = edges.filter((e) => e.edgeType === 'calls');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sourceNodeId).toBe('symbol:php:App\\Svc::run');
    expect(calls[0]?.targetNodeId).toBe('symbol:php:App\\Svc::help');
  });
});
