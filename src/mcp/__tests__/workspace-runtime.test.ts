import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LuxDatabase } from '../../db/index.js';
import {
  WorkspaceRuntime,
  WorkspaceUnavailableError,
  workspaceUnavailablePayload,
  type McpRoot,
} from '../workspace-runtime.js';

interface FakeDatabase {
  readonly path: string;
  close: ReturnType<typeof vi.fn>;
}

const tempRoots: string[] = [];

function makeCorpus(name: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'lux-mcp-roots-'));
  tempRoots.push(parent);
  const corpus = join(parent, name);
  mkdirSync(corpus, { recursive: true });
  return corpus;
}

function root(corpus: string): McpRoot {
  return { uri: pathToFileURL(corpus).href };
}

function harness(options: { env?: Record<string, string | undefined>; cwd?: string } = {}) {
  const opened: FakeDatabase[] = [];
  const runtime = new WorkspaceRuntime({
    env: options.env ?? {},
    cwd: options.cwd ?? makeCorpus('cwd'),
    openDatabase: (path) => {
      const db: FakeDatabase = { path, close: vi.fn() };
      opened.push(db);
      return db as unknown as LuxDatabase;
    },
  });
  return { runtime, opened };
}

async function unavailable(runtime: WorkspaceRuntime): Promise<WorkspaceUnavailableError> {
  try {
    await runtime.acquire();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceUnavailableError);
    return error as WorkspaceUnavailableError;
  }
  throw new Error('Expected workspace acquisition to fail.');
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('WorkspaceRuntime', () => {
  it('uses the single MCP file root and its repository-local index', async () => {
    const corpus = makeCorpus('repo-one');
    const { runtime, opened } = harness();

    await runtime.configureClient(async () => ({ roots: [root(corpus)] }));
    const lease = await runtime.acquire();

    expect(lease.runtime).toEqual({
      corpusPath: corpus,
      corpusSource: 'explicit',
      dbPath: join(corpus, '.lux', 'lux.db'),
      dbSource: 'repo-local',
    });
    expect(opened.map((db) => db.path)).toEqual([join(corpus, '.lux', 'lux.db')]);
    lease.release();
    runtime.dispose();
    expect(opened[0].close).toHaveBeenCalledOnce();
  });

  it('refuses clients without roots instead of guessing from the server cwd', async () => {
    const cwd = makeCorpus('server-installation-directory');
    const { runtime, opened } = harness({ cwd });

    await runtime.configureClient(null);
    const error = await unavailable(runtime);

    expect(error.reason).toBe('roots-empty');
    expect(error.message).toContain('LUX_CORPUS_PATH');
    expect(opened).toHaveLength(0);
    runtime.dispose();
  });

  it('keeps explicit environment overrides fixed instead of following client roots', async () => {
    const configured = makeCorpus('configured-repo');
    const unrelated = makeCorpus('unrelated-root');
    const explicitDb = join(configured, 'custom', 'lux.db');
    const { runtime, opened } = harness({
      env: { LUX_CORPUS_PATH: configured, LUX_DB_PATH: explicitDb },
    });
    const listRoots = vi.fn(async () => ({ roots: [root(unrelated)] }));

    await runtime.configureClient(listRoots);
    await runtime.refreshRoots();
    const lease = await runtime.acquire();

    expect(listRoots).not.toHaveBeenCalled();
    expect(lease.runtime.corpusPath).toBe(configured);
    expect(lease.runtime.corpusSource).toBe('env');
    expect(lease.runtime.dbPath).toBe(explicitDb);
    expect(lease.runtime.dbSource).toBe('env');
    expect(opened.map((db) => db.path)).toEqual([explicitDb]);
    lease.release();
    runtime.dispose();
  });

  it('switches repositories on root refresh and retires the old handle', async () => {
    const first = makeCorpus('first');
    const second = makeCorpus('second');
    let roots = [root(first)];
    const { runtime, opened } = harness();

    await runtime.configureClient(async () => ({ roots }));
    const firstLease = await runtime.acquire();
    roots = [root(second)];
    await runtime.refreshRoots();

    const secondLease = await runtime.acquire();
    expect(secondLease.runtime.corpusPath).toBe(second);
    expect(opened).toHaveLength(2);
    expect(opened[0].close).not.toHaveBeenCalled();

    secondLease.release();
    firstLease.release();
    expect(opened[0].close).toHaveBeenCalledOnce();
    runtime.dispose();
    expect(opened[1].close).toHaveBeenCalledOnce();
  });

  it('isolates a mutating lease from concurrent reads and writers', async () => {
    const corpus = makeCorpus('writer-repo');
    const { runtime, opened } = harness();
    await runtime.configureClient(async () => ({ roots: [root(corpus)] }));

    const read = await runtime.acquire();
    await expect(runtime.acquire('write-existing')).rejects.toMatchObject({
      reason: 'database-open-failed',
    });
    read.release();

    const writer = await runtime.acquire('write-existing');
    await expect(runtime.acquire()).rejects.toMatchObject({ reason: 'database-open-failed' });
    await expect(runtime.acquire('write-existing')).rejects.toMatchObject({
      reason: 'database-open-failed',
    });
    writer.release();
    expect(opened.at(-1)?.close).toHaveBeenCalledOnce();

    const nextRead = await runtime.acquire();
    nextRead.release();
    runtime.dispose();
  });

  it('keeps an active writer tracked through disposal until its lease releases', async () => {
    const corpus = makeCorpus('disposed-writer-repo');
    const { runtime, opened } = harness();
    await runtime.configureClient(async () => ({ roots: [root(corpus)] }));

    const writer = await runtime.acquire('write-existing');
    runtime.dispose();
    expect(opened[0].close).not.toHaveBeenCalled();
    writer.release();
    expect(opened[0].close).toHaveBeenCalledOnce();
  });

  it('waits for the latest in-flight roots refresh before leasing a database', async () => {
    const second = makeCorpus('second');
    let resolveRoots!: (value: { roots: McpRoot[] }) => void;
    const rootsPromise = new Promise<{ roots: McpRoot[] }>((resolve) => {
      resolveRoots = resolve;
    });
    const { runtime } = harness();

    const configuring = runtime.configureClient(async () => rootsPromise);
    const acquisition = runtime.acquire();
    resolveRoots({ roots: [root(second)] });

    await configuring;
    const lease = await acquisition;
    expect(lease.runtime.corpusPath).toBe(second);
    lease.release();
    runtime.dispose();
  });

  it.each([
    ['roots-empty', []],
    ['roots-ambiguous', [root(makeCorpus('one')), root(makeCorpus('two'))]],
  ] as const)('refuses %s instead of guessing a repository', async (reason, roots) => {
    const { runtime, opened } = harness();

    await runtime.configureClient(async () => ({ roots: [...roots] }));
    const error = await unavailable(runtime);

    expect(error.reason).toBe(reason);
    expect(workspaceUnavailablePayload(error).error).toBe('workspace-unavailable');
    expect(opened).toHaveLength(0);
    runtime.dispose();
  });

  it('refuses malformed, non-file, and non-directory roots', async () => {
    const filePath = join(makeCorpus('parent'), 'missing');
    const cases: Array<{ root: McpRoot; reason: string }> = [
      { root: { uri: 'https://example.com/repo' }, reason: 'root-uri-invalid' },
      { root: { uri: pathToFileURL(filePath).href }, reason: 'root-not-directory' },
    ];

    for (const testCase of cases) {
      const { runtime } = harness();
      await runtime.configureClient(async () => ({ roots: [testCase.root] }));
      expect((await unavailable(runtime)).reason).toBe(testCase.reason);
      runtime.dispose();
    }
  });

  it('refuses all new calls when a root refresh fails or becomes ambiguous', async () => {
    const first = makeCorpus('first');
    let mode: 'ok' | 'fail' | 'ambiguous' = 'ok';
    const { runtime, opened } = harness();
    await runtime.configureClient(async () => {
      if (mode === 'fail') throw new Error('client disconnected');
      if (mode === 'ambiguous') return { roots: [root(first), root(makeCorpus('other'))] };
      return { roots: [root(first)] };
    });
    const lease = await runtime.acquire();
    lease.release();

    mode = 'fail';
    await runtime.refreshRoots();
    expect((await unavailable(runtime)).reason).toBe('roots-list-failed');
    expect(opened[0].close).toHaveBeenCalledOnce();

    mode = 'ambiguous';
    await runtime.refreshRoots();
    expect((await unavailable(runtime)).reason).toBe('roots-ambiguous');
    runtime.dispose();
  });
});
