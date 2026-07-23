import { describe, it, expect } from 'vitest';
import {
  splitIdentifiers,
  nodeAnchorContentHash,
  prepareNodeText,
  buildAnchorTexts,
} from '../prepare-node-text.js';
import type { AstNode, Extraction } from '../../ast/extract.js';

describe('splitIdentifiers', () => {
  it('splits PascalCase / camelCase on case boundaries', () => {
    expect(splitIdentifiers('StripeService')).toEqual(['Stripe', 'Service']);
    expect(splitIdentifiers('fooBar')).toEqual(['foo', 'Bar']);
  });

  it('splits an acronym prefix (HTTPServer -> HTTP, Server)', () => {
    expect(splitIdentifiers('HTTPServer')).toEqual(['HTTP', 'Server']);
  });

  it('splits snake_case / kebab-case / separators', () => {
    expect(splitIdentifiers('split_by_platform')).toEqual(['split', 'by', 'platform']);
    expect(splitIdentifiers('App\\Services\\Payments')).toEqual(['App', 'Services', 'Payments']);
  });
});

describe('nodeAnchorContentHash', () => {
  it('is the sha256 hex of the embedText and is stable/deterministic', () => {
    const h = nodeAnchorContentHash('Class StripeService — App\\StripeService (a.php)');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(nodeAnchorContentHash('Class StripeService — App\\StripeService (a.php)')).toBe(h);
    expect(nodeAnchorContentHash('different')).not.toBe(h);
  });
});

function methodDef(startByte: number, endByte: number): AstNode {
  return {
    type: 'method',
    name: 'charge',
    file: 'app/Services/Payments/StripeService.php',
    range: { startLine: 5, startColumn: 0, endLine: 8, endColumn: 1, startByte, endByte },
    container: 'StripeService',
  };
}

describe('prepareNodeText', () => {
  const fileContent = [
    '<?php',
    'namespace App\\Services\\Payments;',
    '',
    'class StripeService {',
    '  /** Charge a card and record the settlement. */',
    '  public function charge(int $amount): Receipt {',
    '    return $this->gateway->charge($amount);',
    '  }',
    '}',
  ].join('\n');

  it('carries the header, signature line, and leading doc-comment; hash matches embedText', () => {
    // byte offset of the `public function charge` line within fileContent
    const startByte = Buffer.from(fileContent, 'utf8').indexOf('public function charge');
    const endByte = startByte + 'public function charge(int $amount): Receipt {'.length + 5;
    const prepared = prepareNodeText({
      nodeId: 'symbol:php:App\\Services\\Payments\\StripeService::charge',
      symbolKind: 'Method',
      name: 'charge',
      qualifiedName: 'App\\Services\\Payments\\StripeService::charge',
      relPath: 'app/Services/Payments/StripeService.php',
      def: methodDef(startByte, endByte),
      fileBytes: Buffer.from(fileContent, 'utf8'),
    });

    expect(prepared.embedText).toContain(
      'Method charge — App\\Services\\Payments\\StripeService::charge (app/Services/Payments/StripeService.php)'
    );
    expect(prepared.fields.context).toContain('public function charge');
    expect(prepared.fields.context.toLowerCase()).toContain('settlement'); // leading doc-comment
    expect(prepared.fields.identifiers).toContain('charge');
    expect(prepared.fields.pathSegments).toContain('payments');
    expect(prepared.fields.qualified).toContain('stripe');
    expect(prepared.contentHash).toBe(nodeAnchorContentHash(prepared.embedText));
  });

  it('handles multi-byte UTF-8 before the definition without corrupting the slice', () => {
    const multibyte = ['// café ☕ résumé', 'function föö() {}'].join('\n');
    const startByte = Buffer.from(multibyte, 'utf8').indexOf('function');
    const endByte = Buffer.from(multibyte, 'utf8').length;
    const prepared = prepareNodeText({
      nodeId: 'symbol:ts:a.ts#föö',
      symbolKind: 'Function',
      name: 'föö',
      relPath: 'a.ts',
      def: {
        type: 'function',
        name: 'föö',
        file: 'a.ts',
        range: { startLine: 2, startColumn: 0, endLine: 2, endColumn: 17, startByte, endByte },
      },
      fileBytes: Buffer.from(multibyte, 'utf8'),
    });
    expect(prepared.fields.context).toContain('function föö()');
  });
});

describe('buildAnchorTexts', () => {
  it('produces one prepared unit per anchor-viable node, deduped by id', () => {
    const content = 'export function foo() {}\nexport class Bar {}\nexport function foo() {}';
    // A minimal extraction mirroring what extractSource emits (two foo defs → deduped to one).
    const extraction: Extraction = {
      nodes: [
        { type: 'function', name: 'foo', file: 'a.ts', range: r(0, 24) },
        { type: 'class', name: 'Bar', file: 'a.ts', range: r(25, 44) },
        { type: 'function', name: 'foo', file: 'a.ts', range: r(45, 69) },
      ],
      edges: [],
    };
    const texts = buildAnchorTexts('a.ts', extraction, 'typescript', content);
    const ids = texts.map((t) => t.nodeId);
    expect(ids).toContain('symbol:ts:a.ts#foo');
    expect(ids).toContain('symbol:ts:a.ts#Bar');
    expect(ids.filter((id) => id === 'symbol:ts:a.ts#foo')).toHaveLength(1); // first-wins dedup
    expect(texts.every((t) => t.contentHash.match(/^[0-9a-f]{64}$/))).toBe(true);
  });
});

function r(startByte: number, endByte: number) {
  return { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0, startByte, endByte };
}
