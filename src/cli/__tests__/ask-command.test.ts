import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { askSpecificExpert, askPanel, formatRouteResultJson } from '../ask.js';
import type {
  ExpertSessionManager,
  QueryOptions,
  QueryResult,
  SessionInfo,
} from '../../experts/session-manager.js';
import type { Expert, ExpertSession } from '../../db/types.js';
import type { RouteResult } from '../../experts/router.js';

// Mock child_process.spawn so LLM routing doesn't call a real routing binary
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const { EventEmitter } = await import('events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      // Return a mock process that immediately fails (simulates missing binary)
      const proc = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(proc, {
        stdout,
        stderr,
        stdin: null,
        stdio: [null, stdout, stderr],
        pid: 1,
        exitCode: null,
        signalCode: null,
        killed: false,
        connected: false,
        kill: () => true,
        ref: () => {},
        unref: () => {},
        disconnect: () => {},
        send: () => false,
        [Symbol.dispose]: () => {},
      });
      queueMicrotask(() => proc.emit('error', new Error('spawn claude ENOENT')));
      return proc;
    }),
  };
});

/** A mock ExpertSessionManager that returns canned responses. */
function createMockSessionManager(responses: Record<string, string> = {}): ExpertSessionManager & {
  queryCalls: Array<{ slug: string; question: string; options?: QueryOptions }>;
} {
  const queryCalls: Array<{ slug: string; question: string; options?: QueryOptions }> = [];

  return {
    queryCalls,

    getSession(expertSlug: string): SessionInfo {
      return {
        session: {
          id: 1,
          expert_id: 1,
          session_ref: `session-${expertSlug}-mock`,
          spawned_at: Date.now(),
          last_active_at: Date.now(),
          status: 'warm',
        } as ExpertSession,
        expert: {
          id: 1,
          slug: expertSlug,
          name: expertSlug,
          mount_path: '/mock',
          model: 'claude-sonnet-4-20250514',
          status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
        } as Expert,
      };
    },

    query(expertSlug: string, question: string, options?: QueryOptions): Promise<QueryResult> {
      queryCalls.push({ slug: expertSlug, question, options });
      const response = responses[expertSlug] ?? `Response from ${expertSlug}`;
      return Promise.resolve({
        response,
        sessionId: 1,
        expertSlug,
      });
    },

    terminate(): void {},
    isAlive(): boolean {
      return true;
    },
  };
}

describe('ask command', () => {
  let dbDir: string;
  let contentDir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'ask-db-'));
    contentDir = mkdtempSync(join(tmpdir(), 'ask-content-'));
    db = new LuxDatabase(join(dbDir, 'test.db'));
  });

  afterEach(() => {
    if (db) db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(contentDir, { recursive: true, force: true });
  });

  describe('askSpecificExpert', () => {
    it('should throw when expert does not exist', async () => {
      const sessionManager = createMockSessionManager();

      await expect(
        askSpecificExpert(db, sessionManager, 'test question', 'nonexistent', {})
      ).rejects.toThrow('Expert not found: nonexistent');
    });

    it('should throw when expert is inactive', async () => {
      const mountDir = join(contentDir, 'inactive-expert');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'inactive',
        name: 'Inactive Expert',
        mount_path: mountDir,
        status: 'inactive',
      });

      const sessionManager = createMockSessionManager();

      await expect(
        askSpecificExpert(db, sessionManager, 'test question', 'inactive', {})
      ).rejects.toThrow('Expert is not active: inactive');
    });

    it('should query the specified expert and output response', async () => {
      const mountDir = join(contentDir, 'my-expert');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'my-expert',
        name: 'My Expert',
        mount_path: mountDir,
        model: 'claude-sonnet-4-20250514',
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'my-expert': 'Expert answer here',
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await askSpecificExpert(db, sessionManager, 'what is this?', 'my-expert', {});

      expect(sessionManager.queryCalls).toHaveLength(1);
      expect(sessionManager.queryCalls[0].slug).toBe('my-expert');
      expect(sessionManager.queryCalls[0].question).toBe('what is this?');
      expect(logSpy).toHaveBeenCalledWith('Expert answer here');

      logSpy.mockRestore();
    });

    it('should output JSON when --json flag is set', async () => {
      const mountDir = join(contentDir, 'json-expert');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'json-expert',
        name: 'JSON Expert',
        mount_path: mountDir,
        model: 'claude-sonnet-4-20250514',
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'json-expert': 'JSON response',
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await askSpecificExpert(db, sessionManager, 'test', 'json-expert', { json: true });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.query).toBe('test');
      expect(output.expert.slug).toBe('json-expert');
      expect(output.expert.name).toBe('JSON Expert');
      expect(output.response).toBe('JSON response');
      expect(output.sessionId).toBe(1);

      logSpy.mockRestore();
    });

    it('should output verbose info to stderr when --verbose is set', async () => {
      const mountDir = join(contentDir, 'verbose-expert');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'verbose-expert',
        name: 'Verbose Expert',
        mount_path: mountDir,
        model: 'claude-sonnet-4-20250514',
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'verbose-expert': 'Verbose response',
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await askSpecificExpert(db, sessionManager, 'test', 'verbose-expert', { verbose: true });

      // Verbose info goes to stderr
      const stderrOutput = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(stderrOutput).toContain('Routing to expert: Verbose Expert');
      expect(stderrOutput).toContain('Model: claude-sonnet-4-20250514');
      expect(stderrOutput).toContain('Session ID: 1');

      // Response goes to stdout
      expect(logSpy).toHaveBeenCalledWith('Verbose response');

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('askPanel', () => {
    it('should handle no active experts gracefully (no throw, prints message)', async () => {
      const sessionManager = createMockSessionManager();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // askPanel no longer throws; it falls through to routeQuery which returns empty
      await askPanel(db, sessionManager, 'test question', {});

      expect(errorSpy).toHaveBeenCalledWith('No experts were able to respond to this query.');
      errorSpy.mockRestore();
    });

    it('should route query to active experts', async () => {
      const mountDir = join(contentDir, 'panel-expert');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'panel-expert',
        name: 'Panel Expert',
        mount_path: mountDir,
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'panel-expert': 'Panel response',
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await askPanel(db, sessionManager, 'test question', {});

      expect(logSpy).toHaveBeenCalledWith('Panel response');

      logSpy.mockRestore();
    });

    it('should output verbose routing info to stderr', async () => {
      const mountDir = join(contentDir, 'verbose-panel');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'verbose-panel',
        name: 'Verbose Panel',
        mount_path: mountDir,
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'verbose-panel': 'Verbose panel response',
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await askPanel(db, sessionManager, 'test', { verbose: true });

      const stderrOutput = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(stderrOutput).toContain('Active experts: 1');
      expect(stderrOutput).toContain('Routing query: "test"');

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should output JSON when --json flag is set', async () => {
      const mountDir = join(contentDir, 'json-panel');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'json-panel',
        name: 'JSON Panel',
        mount_path: mountDir,
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'json-panel': 'JSON panel response',
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await askPanel(db, sessionManager, 'test', { json: true });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.query).toBe('test');
      expect(output.responses).toBeDefined();
      expect(output.matchedExperts).toBeDefined();

      logSpy.mockRestore();
    });
  });

  describe('streaming behavior', () => {
    it('askPanel with stream: true should write chunks via process.stdout.write', async () => {
      const mountDir = join(contentDir, 'stream-panel');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'stream-panel',
        name: 'Stream Panel',
        mount_path: mountDir,
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'stream-panel': 'Streamed response\n',
      });

      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await askPanel(db, sessionManager, 'test', { stream: true });

      // stream: true should NOT call console.log with the response
      expect(logSpy).not.toHaveBeenCalled();

      writeSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('askPanel with stream: false should use console.log for complete response', async () => {
      const mountDir = join(contentDir, 'nostream-panel');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'nostream-panel',
        name: 'No Stream Panel',
        mount_path: mountDir,
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'nostream-panel': 'Buffered response',
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await askPanel(db, sessionManager, 'test', { stream: false });

      expect(logSpy).toHaveBeenCalledWith('Buffered response');

      logSpy.mockRestore();
    });

    it('--json always buffers regardless of stream flag', async () => {
      const mountDir = join(contentDir, 'json-stream');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'json-stream',
        name: 'JSON Stream',
        mount_path: mountDir,
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'json-stream': 'JSON response',
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await askPanel(db, sessionManager, 'test', { json: true, stream: true });

      // JSON output should use console.log, not streaming
      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.responses).toBeDefined();

      // sessionManager should NOT have been passed onChunk
      expect(sessionManager.queryCalls[0].options).toBeUndefined();

      logSpy.mockRestore();
    });

    it('askSpecificExpert with stream: true passes onChunk to session manager', async () => {
      const mountDir = join(contentDir, 'stream-specific');
      mkdirSync(mountDir, { recursive: true });

      db.insertExpert({
        slug: 'stream-specific',
        name: 'Stream Specific',
        mount_path: mountDir,
        model: 'claude-sonnet-4-20250514',
        status: 'active',
      });

      const sessionManager = createMockSessionManager({
        'stream-specific': 'Streamed specific\n',
      });

      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await askSpecificExpert(db, sessionManager, 'test', 'stream-specific', { stream: true });

      // With stream: true, onChunk should be passed to session manager
      expect(sessionManager.queryCalls[0].options).toBeDefined();
      expect(sessionManager.queryCalls[0].options!.onChunk).toBeTypeOf('function');

      // console.log should NOT have been called with the response (it was streamed)
      expect(logSpy).not.toHaveBeenCalled();

      writeSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  describe('formatRouteResultJson', () => {
    it('should format a route result with matched experts and responses', () => {
      const result: RouteResult = {
        query: 'test query',
        matchedExperts: [
          {
            expert: {
              id: 1,
              slug: 'expert-a',
              name: 'Expert A',
              mount_path: '/a',
              model: 'claude-sonnet-4-20250514',
              status: 'active',
              created_at: 0,
              updated_at: 0,
            },
            hits: 3,
            score: -1.5,
          },
        ],
        responses: [
          {
            expertSlug: 'expert-a',
            sessionId: 42,
            response: 'The answer is 42',
          },
        ],
        routingMethod: 'fts5',
      };

      const json = formatRouteResultJson(result);

      expect(json.query).toBe('test query');

      const experts = json.matchedExperts as Array<Record<string, unknown>>;
      expect(experts).toHaveLength(1);
      expect(experts[0].slug).toBe('expert-a');
      expect(experts[0].name).toBe('Expert A');
      expect(experts[0].hits).toBe(3);

      const responses = json.responses as Array<Record<string, unknown>>;
      expect(responses).toHaveLength(1);
      expect(responses[0].expertSlug).toBe('expert-a');
      expect(responses[0].sessionId).toBe(42);
      expect(responses[0].response).toBe('The answer is 42');
    });

    it('should handle empty results', () => {
      const result: RouteResult = {
        query: 'empty',
        matchedExperts: [],
        responses: [],
        routingMethod: 'fts5',
      };

      const json = formatRouteResultJson(result);
      expect(json.query).toBe('empty');
      expect(json.matchedExperts).toEqual([]);
      expect(json.responses).toEqual([]);
    });
  });
});
