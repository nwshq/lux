import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateMountPath } from '../expert.js';

describe('validateMountPath', () => {
  let contentDir: string;

  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'content-'));
  });

  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  describe('valid mount paths', () => {
    it('should accept a relative path inside content root that exists', () => {
      mkdirSync(join(contentDir, 'experts'));
      mkdirSync(join(contentDir, 'experts', 'my-expert'));

      const result = validateMountPath('experts/my-expert', contentDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(join(contentDir, 'experts', 'my-expert'));
      }
    });

    it('should accept an absolute path inside content root that exists', () => {
      mkdirSync(join(contentDir, 'agents'));
      const absPath = join(contentDir, 'agents');

      const result = validateMountPath(absPath, contentDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(absPath);
      }
    });

    it('should accept content root itself', () => {
      const result = validateMountPath('.', contentDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(contentDir);
      }
    });

    it('should accept a deeply nested path inside content root', () => {
      mkdirSync(join(contentDir, 'a', 'b', 'c'), { recursive: true });

      const result = validateMountPath('a/b/c', contentDir);
      expect(result.ok).toBe(true);
    });
  });

  describe('paths outside content root', () => {
    it('should reject an absolute path outside content root', () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));

      const result = validateMountPath(outsideDir, contentDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('must be inside content root');
        expect(result.error).toContain('outside');
      }

      rmSync(outsideDir, { recursive: true, force: true });
    });

    it('should reject a relative path that traverses out of content root', () => {
      const result = validateMountPath('../../etc', contentDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('must be inside content root');
      }
    });

    it('should reject a path that starts inside but traverses out', () => {
      mkdirSync(join(contentDir, 'experts'));

      const result = validateMountPath('experts/../../..', contentDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('must be inside content root');
      }
    });
  });

  describe('non-existent paths inside content root', () => {
    it('should reject a relative path that does not exist', () => {
      const result = validateMountPath('nonexistent/dir', contentDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('does not exist');
      }
    });

    it('should reject an absolute path inside content root that does not exist', () => {
      const absPath = join(contentDir, 'no-such-dir');

      const result = validateMountPath(absPath, contentDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('does not exist');
      }
    });
  });
});
