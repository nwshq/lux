import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { SubprocessSessionManager } from '../subprocess-manager.js';

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const mockSpawn = vi.mocked(spawn);

/** Creates a mock ChildProcess with controllable stdout/stderr/exit. */
function createMockProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  Object.assign(proc, {
    stdout,
    stderr,
    stdin: null,
    stdio: [null, stdout, stderr],
    pid: Math.floor(Math.random() * 100000),
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    connected: false,
    kill: vi.fn().mockImplementation(function (this: typeof proc) {
      (this as unknown as { killed: boolean }).killed = true;
      return true;
    }),
    ref: vi.fn(),
    unref: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  });
  return proc;
}

/** Simulates a successful process completion with given output. */
function resolveProcess(proc: ReturnType<typeof spawn>, output: string) {
  proc.stdout!.emit('data', Buffer.from(output));
  (proc as unknown as { exitCode: number }).exitCode = 0;
  proc.emit('close', 0);
}

/** Simulates a failed process completion. */
function rejectProcess(proc: ReturnType<typeof spawn>, stderrOutput: string, code = 1) {
  proc.stderr!.emit('data', Buffer.from(stderrOutput));
  (proc as unknown as { exitCode: number }).exitCode = code;
  proc.emit('close', code);
}

/** Simulates a spawn error (e.g. command not found). */
function errorProcess(proc: ReturnType<typeof spawn>, message: string) {
  proc.emit('error', new Error(message));
}

describe('SubprocessSessionManager', () => {
  const testDir = join(__dirname, 'fixtures', 'subprocess-test');
  const dbPath = join(testDir, 'test.db');
  const mountPath = join(testDir, 'expert-mount');
  let db: LuxDatabase;
  let manager: SubprocessSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(mountPath, { recursive: true });

    db = new LuxDatabase(dbPath);
    manager = new SubprocessSessionManager(db);
  });

  afterEach(() => {
    manager.terminateAll();
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createExpert(
    slug = 'test-expert',
    overrides?: { claude_md_path?: string; status?: string },
  ) {
    db.insertExpert({
      slug,
      name: `Expert ${slug}`,
      mount_path: mountPath,
      model: 'claude-sonnet-4-20250514',
      ...overrides,
    });
  }

  describe('getSession', () => {
    it('should create a new session for an expert', () => {
      createExpert();
      const { session, expert } = manager.getSession('test-expert');

      expect(session).toBeDefined();
      expect(session.status).toBe('warm');
      expect(session.session_ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(expert.slug).toBe('test-expert');
    });

    it('should reuse an existing warm session', () => {
      createExpert();
      const first = manager.getSession('test-expert');
      const second = manager.getSession('test-expert');

      expect(first.session.id).toBe(second.session.id);
    });

    it('should throw for non-existent expert', () => {
      expect(() => manager.getSession('ghost')).toThrow('Expert not found: ghost');
    });
  });

  describe('query', () => {
    it('should spawn claude CLI and return stdout', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('test-expert', 'What is TypeScript?');
      resolveProcess(mockProc, 'TypeScript is a typed superset of JavaScript.');
      const result = await promise;

      expect(result.response).toBe('TypeScript is a typed superset of JavaScript.');
      expect(result.expertSlug).toBe('test-expert');
      expect(result.sessionId).toBeGreaterThan(0);
    });

    it('should pass correct CLI arguments without --resume on first query', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('test-expert', 'Hello');

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];

      expect(args).toContain('--print');
      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-20250514');
      expect(args).toContain('Hello');
      expect(args).not.toContain('--resume');

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.anything(),
        expect.objectContaining({
          cwd: mountPath,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );

      resolveProcess(mockProc, 'response');
      await promise;
    });

    it('should include system prompt from claude.md when available', async () => {
      const claudeMdPath = join(mountPath, 'claude.md');
      writeFileSync(claudeMdPath, 'You are a TypeScript expert.');
      createExpert('ts-expert', { claude_md_path: claudeMdPath });

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('ts-expert', 'Hello');

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '--system-prompt',
          'You are a TypeScript expert.',
        ]),
        expect.anything(),
      );

      resolveProcess(mockProc, 'response');
      await promise;
    });

    it('should set session status to warm after successful query', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const { session } = manager.getSession('test-expert');
      const promise = manager.query('test-expert', 'Hello');

      resolveProcess(mockProc, 'done');
      await promise;

      const updated = db.getExpertSession(session.id);
      expect(updated!.status).toBe('warm');
    });

    it('should set session to idle on failure', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const { session } = manager.getSession('test-expert');
      const promise = manager.query('test-expert', 'Hello');
      rejectProcess(mockProc, 'something went wrong');

      await expect(promise).rejects.toThrow('Expert query failed');

      const updated = db.getExpertSession(session.id);
      expect(updated!.status).toBe('idle');
    });

    it('should reject when expert is not active', async () => {
      createExpert('inactive-expert', { status: 'inactive' });

      await expect(manager.query('inactive-expert', 'Hello')).rejects.toThrow(
        'Expert is not active',
      );
    });

    it('should reject when mount path does not exist', async () => {
      db.insertExpert({
        slug: 'no-mount',
        name: 'No Mount',
        mount_path: '/nonexistent/path',
        model: 'claude-sonnet-4-20250514',
      });

      await expect(manager.query('no-mount', 'Hello')).rejects.toThrow(
        'Expert mount path does not exist',
      );
    });

    it('should prevent concurrent queries to the same expert', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      // Start first query
      const first = manager.query('test-expert', 'First');

      // Second query should be rejected because the expert already has an active query
      await expect(manager.query('test-expert', 'Second')).rejects.toThrow(
        'already has an active query',
      );

      resolveProcess(mockProc, 'done');
      await first;
    });

    it('should handle spawn errors', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('test-expert', 'Hello');
      errorProcess(mockProc, 'spawn claude ENOENT');

      await expect(promise).rejects.toThrow('Expert query failed: spawn claude ENOENT');
    });

    it('should log events on successful query', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('test-expert', 'What is TS?');
      resolveProcess(mockProc, 'A typed language.');
      await promise;

      const events = db
        .getRecentEvents(100)
        .filter((e: { event_type: string }) => e.event_type === 'expert_ask');
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('subprocess-session-manager');
    });

    it('should log events on failed query', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('test-expert', 'What is TS?');
      rejectProcess(mockProc, 'timeout');

      await promise.catch(() => {});

      const events = db
        .getRecentEvents(100)
        .filter((e: { event_type: string }) => e.event_type === 'expert_ask_error');
      expect(events).toHaveLength(1);
      expect(events[0].source).toBe('subprocess-session-manager');
    });
  });

  describe('streaming with onChunk', () => {
    it('should call onChunk with each stdout chunk', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const chunks: string[] = [];
      const onChunk = (chunk: string) => chunks.push(chunk);

      const promise = manager.query('test-expert', 'Hello', { onChunk });

      // Emit multiple chunks before closing
      mockProc.stdout!.emit('data', Buffer.from('Hello '));
      mockProc.stdout!.emit('data', Buffer.from('World'));
      (mockProc as unknown as { exitCode: number }).exitCode = 0;
      mockProc.emit('close', 0);

      const result = await promise;

      expect(chunks).toEqual(['Hello ', 'World']);
      expect(result.response).toBe('Hello World');
    });

    it('should not call onChunk when not provided', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('test-expert', 'Hello');

      // This should not throw even without onChunk
      mockProc.stdout!.emit('data', Buffer.from('Response'));
      (mockProc as unknown as { exitCode: number }).exitCode = 0;
      mockProc.emit('close', 0);

      const result = await promise;
      expect(result.response).toBe('Response');
    });

    it('should still accumulate full response when streaming', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const onChunk = vi.fn();
      const promise = manager.query('test-expert', 'Hello', { onChunk });

      mockProc.stdout!.emit('data', Buffer.from('Part 1 '));
      mockProc.stdout!.emit('data', Buffer.from('Part 2 '));
      mockProc.stdout!.emit('data', Buffer.from('Part 3'));
      (mockProc as unknown as { exitCode: number }).exitCode = 0;
      mockProc.emit('close', 0);

      const result = await promise;

      expect(onChunk).toHaveBeenCalledTimes(3);
      expect(result.response).toBe('Part 1 Part 2 Part 3');
    });
  });

  describe('terminate', () => {
    it('should kill an active process and remove the session', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      // Get the session ID before query changes it
      const { session } = manager.getSession('test-expert');
      const promise = manager.query('test-expert', 'Hello');

      manager.terminate(session.id);

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.activeCount).toBe(0);

      // Clean up the dangling promise
      resolveProcess(mockProc, '');
      await promise.catch(() => {});
    });

    it('should handle terminating a non-existent session', () => {
      expect(() => manager.terminate(9999)).not.toThrow();
    });

    it('should delete the session from the database', () => {
      createExpert();
      const { session } = manager.getSession('test-expert');

      manager.terminate(session.id);

      expect(db.getExpertSession(session.id)).toBeUndefined();
    });
  });

  describe('isAlive', () => {
    it('should return true for warm sessions', () => {
      createExpert();
      const { session } = manager.getSession('test-expert');

      expect(manager.isAlive(session.id)).toBe(true);
    });

    it('should return true for active sessions', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const { session } = manager.getSession('test-expert');
      const promise = manager.query('test-expert', 'Hello');

      // Session was marked active by query()
      expect(manager.isAlive(session.id)).toBe(true);

      resolveProcess(mockProc, 'done');
      await promise;
    });

    it('should return false for non-existent sessions', () => {
      expect(manager.isAlive(9999)).toBe(false);
    });
  });

  describe('activeCount', () => {
    it('should be zero when no queries are running', () => {
      expect(manager.activeCount).toBe(0);
    });

    it('should track running queries', async () => {
      createExpert('expert-a');
      createExpert('expert-b');

      const procA = createMockProcess();
      const procB = createMockProcess();
      mockSpawn.mockReturnValueOnce(procA).mockReturnValueOnce(procB);

      const promiseA = manager.query('expert-a', 'Hello');
      const promiseB = manager.query('expert-b', 'Hello');

      expect(manager.activeCount).toBe(2);

      resolveProcess(procA, 'done');
      await promiseA;

      expect(manager.activeCount).toBe(1);

      resolveProcess(procB, 'done');
      await promiseB;

      expect(manager.activeCount).toBe(0);
    });
  });

  describe('getActiveSessionIds', () => {
    it('should return empty array when idle', () => {
      expect(manager.getActiveSessionIds()).toEqual([]);
    });

    it('should return session IDs of running queries', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const { session } = manager.getSession('test-expert');
      const promise = manager.query('test-expert', 'Hello');

      expect(manager.getActiveSessionIds()).toContain(session.id);

      resolveProcess(mockProc, 'done');
      await promise;
    });
  });

  describe('hasActiveQuery', () => {
    it('should return false when no query is running', () => {
      createExpert();
      expect(manager.hasActiveQuery('test-expert')).toBe(false);
    });

    it('should return true when a query is in progress', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('test-expert', 'Hello');

      expect(manager.hasActiveQuery('test-expert')).toBe(true);

      resolveProcess(mockProc, 'done');
      await promise;

      expect(manager.hasActiveQuery('test-expert')).toBe(false);
    });
  });

  describe('terminateAll', () => {
    it('should kill all active processes', async () => {
      createExpert('expert-a');
      createExpert('expert-b');

      const procA = createMockProcess();
      const procB = createMockProcess();
      mockSpawn.mockReturnValueOnce(procA).mockReturnValueOnce(procB);

      const promiseA = manager.query('expert-a', 'Hello');
      const promiseB = manager.query('expert-b', 'Hello');

      expect(manager.activeCount).toBe(2);

      manager.terminateAll();

      expect(procA.kill).toHaveBeenCalledWith('SIGTERM');
      expect(procB.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.activeCount).toBe(0);

      // Clean up dangling promises
      resolveProcess(procA, '');
      resolveProcess(procB, '');
      await Promise.allSettled([promiseA, promiseB]);
    });
  });

  describe('timeout handling', () => {
    it('should reject queries that exceed the timeout', async () => {
      vi.useFakeTimers();

      const shortManager = new SubprocessSessionManager(db, {
        queryTimeoutMs: 1000,
      });
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = shortManager.query('test-expert', 'Hello');

      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow('Query timed out after 1000ms');

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

      vi.useRealTimers();
    });
  });

  describe('environment isolation', () => {
    it('should spawn with a clean env that has PATH but lacks CLAUDECODE', async () => {
      // Simulate a parent env with CLAUDECODE set
      const originalClaudeCode = process.env.CLAUDECODE;
      process.env.CLAUDECODE = '1';

      try {
        createExpert();

        const mockProc = createMockProcess();
        mockSpawn.mockReturnValue(mockProc);

        const promise = manager.query('test-expert', 'Hello');

        const spawnCall = mockSpawn.mock.calls[0];
        const spawnOptions = spawnCall[2] as { env: Record<string, string> };

        expect(spawnOptions.env).toBeDefined();
        expect(spawnOptions.env.PATH).toBeDefined();
        expect(spawnOptions.env).not.toHaveProperty('CLAUDECODE');

        resolveProcess(mockProc, 'done');
        await promise;
      } finally {
        if (originalClaudeCode === undefined) {
          delete process.env.CLAUDECODE;
        } else {
          process.env.CLAUDECODE = originalClaudeCode;
        }
      }
    });
  });

  describe('conversation resumption', () => {
    it('should pass --resume with session_ref on follow-up queries', async () => {
      createExpert();

      // First query — establishes the session
      const firstProc = createMockProcess();
      mockSpawn.mockReturnValue(firstProc);

      const { session } = manager.getSession('test-expert');
      const firstPromise = manager.query('test-expert', 'First question');
      resolveProcess(firstProc, 'first response');
      await firstPromise;

      // Second query — should resume the existing session
      const secondProc = createMockProcess();
      mockSpawn.mockReturnValue(secondProc);

      const secondPromise = manager.query('test-expert', 'Follow up');

      const spawnCall = mockSpawn.mock.calls[1];
      const args = spawnCall[1] as string[];
      expect(args).toContain('--resume');
      expect(args).toContain(session.session_ref);

      resolveProcess(secondProc, 'second response');
      await secondPromise;
    });

    it('should not pass --resume on the first query of a new session', async () => {
      createExpert();

      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const promise = manager.query('test-expert', 'First question');

      const spawnCall = mockSpawn.mock.calls[0];
      const args = spawnCall[1] as string[];
      expect(args).not.toContain('--resume');

      resolveProcess(mockProc, 'response');
      await promise;
    });
  });
});
