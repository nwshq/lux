import { describe, expect, it } from 'vitest';
import {
  mapScriptByteOffset,
  sourceLocationAt,
  utf8ByteOffsetToCodeUnitOffset,
} from '../source-map.js';

describe('Vue source mapping', () => {
  it('converts UTF-8 bytes without confusing them with UTF-16 code units', () => {
    const source = 'é😀target';
    expect(utf8ByteOffsetToCodeUnitOffset(source, Buffer.byteLength('é😀'))).toBe(3);
    expect(() => utf8ByteOffsetToCodeUnitOffset(source, -1)).toThrow(RangeError);
    expect(() => utf8ByteOffsetToCodeUnitOffset(source, 100)).toThrow(RangeError);
  });

  it('uses one-based lines and zero-based UTF-16 columns', () => {
    expect(sourceLocationAt('A.vue', 'one\n😀two', 6)).toEqual({
      filePath: 'A.vue',
      line: 2,
      column: 2,
    });
    expect(() => sourceLocationAt('A.vue', 'x', 2)).toThrow(RangeError);
  });

  it('maps a script byte offset through the exact original block offset', () => {
    const block = 'const café = useThing()';
    const sfc = `<script>\n${block}\n</script>`;
    const start = sfc.indexOf(block);
    const byte = Buffer.byteLength(block.slice(0, block.indexOf('useThing')));
    expect(mapScriptByteOffset('A.vue', sfc, start, block, byte)).toEqual({
      filePath: 'A.vue',
      line: 2,
      column: 13,
    });
  });
});
