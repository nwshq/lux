import { describe, it, expect } from 'vitest';
import type { DocumentSymbol } from 'vscode-languageserver-protocol';
import { toEnrichedSymbol } from '../index.js';

// Robustness: some servers (intelephense on Blade `.blade.php` templates) return
// DocumentSymbols with no `range`. toEnrichedSymbol must degrade gracefully
// instead of throwing and failing the whole file's enrichment.

describe('toEnrichedSymbol', () => {
  it('maps a well-formed symbol with its range', () => {
    const sym = {
      name: 'save',
      kind: 6,
      range: { start: { line: 10, character: 0 }, end: { line: 20, character: 1 } },
      selectionRange: { start: { line: 10, character: 4 }, end: { line: 10, character: 8 } },
    } as DocumentSymbol;
    const e = toEnrichedSymbol(sym);
    expect(e.startLine).toBe(10);
    expect(e.endLine).toBe(20);
  });

  it('falls back to selectionRange when range is absent', () => {
    const sym = {
      name: 'x',
      kind: 13,
      selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } },
    } as unknown as DocumentSymbol;
    const e = toEnrichedSymbol(sym);
    expect(e.startLine).toBe(5);
    expect(e.endLine).toBe(5);
  });

  it('does not throw and defaults to 0 when both range and selectionRange are absent', () => {
    const sym = { name: 'y', kind: 13 } as unknown as DocumentSymbol;
    expect(() => toEnrichedSymbol(sym)).not.toThrow();
    const e = toEnrichedSymbol(sym);
    expect(e.startLine).toBe(0);
    expect(e.endLine).toBe(0);
  });
});
