import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { resolve as resolvePath } from 'path';
import type { DiscoveryContext, DiscoveryOptions } from '../types.js';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'child_process';
import { analyze } from '../analyze.js';

const mockSpawn = vi.mocked(spawn);

function createMockClaudeProcess(stdout: string, code = 0) {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  Object.assign(proc, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    stdin: null,
    stdio: [null, stdoutEmitter, stderrEmitter],
    pid: 1,
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    connected: false,
    kill: vi.fn().mockReturnValue(true),
    ref: vi.fn(),
    unref: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  });

  queueMicrotask(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout));
    (proc as unknown as { exitCode: number }).exitCode = code;
    proc.emit('close', code);
  });

  return proc;
}

function makeContext(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return {
    tree: 'root/\n├── src/\n└── docs/',
    fileCountsByDirectory: {},
    existingExperts: [],
    ...overrides,
  };
}

function makeOptions(overrides: Partial<DiscoveryOptions> = {}): DiscoveryOptions {
  return {
    rootPath: '/tmp/target-corpus',
    model: 'claude-sonnet-4-20250514',
    ...overrides,
  };
}

describe('analyze Claude subprocess cwd pinning', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('passes the discovery rootPath as Claude subprocess cwd', async () => {
    mockSpawn.mockReturnValue(
      createMockClaudeProcess(JSON.stringify({ experts: [], rationale: 'ok' }))
    );

    await analyze(makeContext(), makeOptions());

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0]?.[0]).toBe('claude');
    expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: '/tmp/target-corpus',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('resolves a relative discovery rootPath before spawning Claude', async () => {
    mockSpawn.mockReturnValue(
      createMockClaudeProcess(JSON.stringify({ experts: [], rationale: 'ok' }))
    );

    await analyze(makeContext(), makeOptions({ rootPath: 'fixtures/example-app' }));

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: resolvePath('fixtures/example-app'),
    });
  });
});
