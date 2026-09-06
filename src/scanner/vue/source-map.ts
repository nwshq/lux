import type { SourceLocationV1 } from '../contracts/program.js';

/** Convert tree-sitter's UTF-8 byte offset to a JavaScript UTF-16 code-unit offset. */
export function utf8ByteOffsetToCodeUnitOffset(source: string, byteOffset: number): number {
  const bytes = Buffer.from(source, 'utf8');
  if (byteOffset < 0 || byteOffset > bytes.length) throw new RangeError('byte offset out of range');
  return bytes.subarray(0, byteOffset).toString('utf8').length;
}

/** Locate a JavaScript string offset using Lux's one-based-line/zero-based-column convention. */
export function sourceLocationAt(
  filePath: string,
  source: string,
  codeUnitOffset: number
): SourceLocationV1 {
  if (codeUnitOffset < 0 || codeUnitOffset > source.length) {
    throw new RangeError('source offset out of range');
  }
  const prefix = source.slice(0, codeUnitOffset);
  const lines = prefix.split('\n');
  return { filePath, line: lines.length, column: lines[lines.length - 1]?.length ?? 0 };
}

/** Map a byte offset in a virtual script block back into the original SFC. */
export function mapScriptByteOffset(
  filePath: string,
  sfcSource: string,
  blockStartOffset: number,
  blockSource: string,
  byteOffset: number
): SourceLocationV1 {
  return sourceLocationAt(
    filePath,
    sfcSource,
    blockStartOffset + utf8ByteOffsetToCodeUnitOffset(blockSource, byteOffset)
  );
}
