// Fix #3: getDiffNameStatus must place `--end-of-options` (git 2.24+) before the base operand so the
// option/operand boundary is explicit — defense-in-depth on top of assertSafeGitRef, future-proof
// against a grammar relaxation (Decision 17). Asserting the argv directly requires a stubbed
// child_process, so this lives in its own file (vi.mock is file-scoped); the real-repo behavior is
// covered separately by delta-git-safety.test.ts.

import { describe, it, expect, vi } from 'vitest';

const execFileSyncMock = vi.fn<(...args: unknown[]) => string>(() => 'M\tfoo.php\n');
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  execSync: vi.fn(),
}));

const { getDiffNameStatus } = await import('../git.js');

describe('getDiffNameStatus argv — end-of-options separator (fix #3)', () => {
  it('passes --end-of-options, positioned before the base operand', () => {
    execFileSyncMock.mockClear();
    const entries = getDiffNameStatus('/repo', 'abc123', 'HEAD');

    // the canned diff still parses (the wrapper is otherwise unchanged).
    expect(entries).toEqual([{ status: 'modified', path: 'foo.php' }]);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, argv] = execFileSyncMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('git');
    expect(argv).toContain('--end-of-options');
    const sepIdx = argv.indexOf('--end-of-options');
    expect(sepIdx).toBeLessThan(argv.indexOf('abc123')); // separator precedes the base
    expect(sepIdx).toBeLessThan(argv.indexOf('HEAD')); // and the head operand
  });
});
