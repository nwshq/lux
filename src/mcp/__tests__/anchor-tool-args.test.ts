import { describe, it, expect } from 'vitest';
import { coerceAnchorToolArgs } from '../anchor-tool-args.js';

// The `lux_anchors` MCP handler is exposed to a prompt-injectable agent, so its argument coercion must
// fail SAFE (out-of-enum / wrong-type → the default) rather than throw on the resident server. This
// pins that contract directly — server.ts destructures the result of this function verbatim.
describe('coerceAnchorToolArgs', () => {
  it('defaults an empty/missing arg object to node granularity, tests-excluded, limit 10', () => {
    expect(coerceAnchorToolArgs({})).toEqual({
      query: '',
      limit: 10,
      granularity: 'node',
      includeTests: false,
    });
    expect(coerceAnchorToolArgs(undefined)).toEqual({
      query: '',
      limit: 10,
      granularity: 'node',
      includeTests: false,
    });
  });

  it('passes through valid values', () => {
    expect(coerceAnchorToolArgs({ query: 'settlement', limit: 25, granularity: 'file' })).toEqual({
      query: 'settlement',
      limit: 25,
      granularity: 'file',
      includeTests: false,
    });
    expect(coerceAnchorToolArgs({ query: 'x', include_tests: true })).toMatchObject({
      includeTests: true,
    });
  });

  it('coerces an out-of-enum / wrong-cased granularity to node (only exact "file" selects file)', () => {
    expect(coerceAnchorToolArgs({ granularity: 'File' }).granularity).toBe('node');
    expect(coerceAnchorToolArgs({ granularity: 'FILE' }).granularity).toBe('node');
    expect(coerceAnchorToolArgs({ granularity: 'symbol' }).granularity).toBe('node');
    expect(coerceAnchorToolArgs({ granularity: 42 }).granularity).toBe('node');
  });

  it('coerces a non-boolean include_tests (e.g. the string "true") to false — fail-safe to excluding tests', () => {
    expect(coerceAnchorToolArgs({ include_tests: 'true' }).includeTests).toBe(false);
    expect(coerceAnchorToolArgs({ include_tests: 1 }).includeTests).toBe(false);
    expect(coerceAnchorToolArgs({ include_tests: 'false' }).includeTests).toBe(false);
    expect(coerceAnchorToolArgs({ include_tests: false }).includeTests).toBe(false);
  });

  it('coerces a bad limit (non-number, <1, non-finite) to 10 and truncates a float', () => {
    expect(coerceAnchorToolArgs({ limit: '5' }).limit).toBe(10);
    expect(coerceAnchorToolArgs({ limit: 0 }).limit).toBe(10);
    expect(coerceAnchorToolArgs({ limit: -3 }).limit).toBe(10);
    expect(coerceAnchorToolArgs({ limit: Number.NaN }).limit).toBe(10);
    expect(coerceAnchorToolArgs({ limit: 2.9 }).limit).toBe(2);
  });

  it('coerces a non-string query to empty string', () => {
    expect(coerceAnchorToolArgs({ query: 123 }).query).toBe('');
    expect(coerceAnchorToolArgs({ query: null }).query).toBe('');
  });
});
