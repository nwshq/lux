import { describe, it, expect } from 'vitest';
import { buildTypedReceiverEntries } from '../general.js';

function k(filePath: string, opts: { type?: string; content?: string } = {}) {
  return {
    type: opts.type ?? 'source-code',
    title: filePath,
    filePath,
    content: opts.content ?? '<?php',
  };
}

describe('buildTypedReceiverEntries (E1 follow-up #2 — first-party work-list)', () => {
  it('unions promoted first-party source with the base work-list when present', () => {
    const base = [k('/app/app/Foo.php')];
    const firstParty = [k('/kernel/src/Bar.php')];
    expect(buildTypedReceiverEntries(base, firstParty).map((e) => e.filePath)).toEqual([
      '/app/app/Foo.php',
      '/kernel/src/Bar.php',
    ]);
  });

  it('is identical to the base when there is no first-party source (single-repo)', () => {
    const base = [k('/app/app/Foo.php'), k('/app/app/Baz.php')];
    expect(buildTypedReceiverEntries(base, []).map((e) => e.filePath)).toEqual([
      '/app/app/Foo.php',
      '/app/app/Baz.php',
    ]);
  });

  it('filters non-source, contentless, and non-enrichable-language entries (base + first-party)', () => {
    const base = [
      k('/app/app/Foo.php'), // kept
      k('/app/app/NoContent.php', { content: '' }), // dropped: no content
      k('/notes/y.md', { type: 'knowledge' }), // dropped: not source-code
    ];
    const firstParty = [
      k('/kernel/src/Bar.php'), // kept
      k('/kernel/img.png', { content: 'x' }), // dropped: langForFile(.png) === null
    ];
    expect(buildTypedReceiverEntries(base, firstParty).map((e) => e.filePath)).toEqual([
      '/app/app/Foo.php',
      '/kernel/src/Bar.php',
    ]);
  });
});
