import { describe, expect, it } from 'vitest';
import {
  SOURCE_EXTENSIONS,
  existingCandidates,
  normalizeRepositoryPath,
  sourceCandidates,
} from '../candidates.js';

describe('project-resolution candidates', () => {
  describe('normalizeRepositoryPath', () => {
    it.each([
      ['src/file.ts', 'src/file.ts'],
      ['./src/file.ts', 'src/file.ts'],
      ['src/./nested/../file.ts', 'src/file.ts'],
      ['src\\nested\\file.ts', 'src/nested/file.ts'],
      ['.\\src\\nested\\..\\file.ts', 'src/file.ts'],
      ['src/../outside.ts', 'outside.ts'],
      ['C:\\repo\\file.ts', 'C:/repo/file.ts'],
    ])('normalizes the repository path %j', (input, expected) => {
      expect(normalizeRepositoryPath(input)).toBe(expected);
    });

    it.each([
      '..',
      '../outside.ts',
      'src/../../outside.ts',
      '..\\outside.ts',
      '/src/file.ts',
      '\0',
      'src/line\nfeed.ts',
      'src/carriage\rreturn.ts',
      'src/tab\tfile.ts',
      'src/delete\u007ffile.ts',
    ])('rejects escaping, absolute, or control-containing path %j', (input) => {
      expect(normalizeRepositoryPath(input)).toBeNull();
    });
  });

  describe('sourceCandidates', () => {
    it('uses the frozen source-extension order for direct paths before indexes', () => {
      expect(SOURCE_EXTENSIONS).toEqual(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue']);
      expect(sourceCandidates('./src/feature')).toEqual([
        'src/feature.ts',
        'src/feature.tsx',
        'src/feature.js',
        'src/feature.jsx',
        'src/feature.mjs',
        'src/feature.cjs',
        'src/feature.vue',
        'src/feature/index.ts',
        'src/feature/index.tsx',
        'src/feature/index.js',
        'src/feature/index.jsx',
        'src/feature/index.mjs',
        'src/feature/index.cjs',
        'src/feature/index.vue',
      ]);
    });

    it.each(SOURCE_EXTENSIONS)('keeps an explicit %s source path exact', (extension) => {
      expect(sourceCandidates(`src/feature${extension}`)).toEqual([`src/feature${extension}`]);
    });

    it('normalizes Windows separators before creating candidates', () => {
      expect(sourceCandidates('src\\feature').slice(0, 2)).toEqual([
        'src/feature.ts',
        'src/feature.tsx',
      ]);
    });

    it('returns no candidates for invalid paths', () => {
      expect(sourceCandidates('../../escape')).toEqual([]);
      expect(sourceCandidates('src/control\npath')).toEqual([]);
    });
  });

  describe('existingCandidates', () => {
    it('deduplicates matches and returns deterministic lexical ambiguity order', () => {
      const files = new Set([
        'src/feature/index.vue',
        'src/feature.tsx',
        'src/feature.js',
        'src/feature.ts',
      ]);

      expect(existingCandidates(['src/feature', './src/feature'], files)).toEqual([
        'src/feature.js',
        'src/feature.ts',
        'src/feature.tsx',
        'src/feature/index.vue',
      ]);
    });

    it('does not normalize the source-file inventory implicitly', () => {
      expect(existingCandidates(['src/feature'], new Set(['src\\feature.ts']))).toEqual([]);
    });
  });
});
