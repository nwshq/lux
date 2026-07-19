import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTypedReceiverEdges, type ResolveDefinition } from '../lsp-resolve.js';

// Regression guard for the composer path-repo (symlinked-kernel) case: the language
// server resolves a definition through the `vendor/<pkg>` symlink, while the scan
// keyed that file by its realpath (sibling). Without canonicalizing the resolved
// path, the `defRangesByRel` map key never matches and the kernel-internal edge is
// dropped. These tests use REAL filesystem symlinks (so `realpathSync` is exercised)
// and an injected resolver (so no language server is required — runs in CI).
describe('resolveTypedReceiverEdges — symlinked-kernel path canonicalization', () => {
  let base: string;
  let rootDir: string;
  let siblingDir: string;

  beforeAll(() => {
    // realpath the tmp base so there is no /tmp vs /private/tmp ambiguity — the
    // ONLY symlink under test is the vendor/pkg -> sibling one we create.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'lux-symlink-canon-')));
    rootDir = join(base, 'root');
    siblingDir = join(base, 'sibling'); // the kernel's realpath source

    mkdirSync(join(rootDir, 'app'), { recursive: true });
    mkdirSync(join(rootDir, 'vendor'), { recursive: true });
    mkdirSync(siblingDir, { recursive: true });

    // The caller (client app) makes a typed-receiver call into the kernel.
    writeFileSync(
      join(rootDir, 'app', 'Caller.php'),
      [
        '<?php',
        'namespace App;',
        'class Caller {',
        '  function run($repo) { $repo->doThing(); }',
        '}',
      ].join('\n')
    );
    // The kernel target, in its realpath (sibling) location.
    writeFileSync(
      join(siblingDir, 'Repo.php'),
      ['<?php', 'namespace Kernel;', 'class Repo {', '  function doThing() {}', '}'].join('\n')
    );
    // The composer path-repo symlink: root/vendor/pkg -> sibling.
    symlinkSync(siblingDir, join(rootDir, 'vendor', 'pkg'));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('maps a call the LSP resolves through the vendor symlink to the realpath-keyed symbol', async () => {
    // The kernel entry is keyed by its REALPATH (sibling) — as `resolveFirstPartyRoots`
    // does; the pass parses entry.content.
    const entries = [
      { filePath: join(rootDir, 'app', 'Caller.php') },
      { filePath: join(siblingDir, 'Repo.php') },
    ].map((e) => ({ ...e, content: readFileSync(e.filePath, 'utf8') }));

    // The LSP returns the definition through the SYMLINK path (root/vendor/pkg/Repo.php),
    // NOT the realpath sibling — exactly what intelephense does against a client vendor/.
    const symlinkTarget = join(rootDir, 'vendor', 'pkg', 'Repo.php');
    const resolveDefinition: ResolveDefinition = (file) =>
      Promise.resolve(
        file === join(rootDir, 'app', 'Caller.php')
          ? { filePath: symlinkTarget, line: 3 } // doThing() is on 0-based line 3
          : null
      );

    const edges = await resolveTypedReceiverEdges(entries, rootDir, resolveDefinition, 1000);

    // Without canonicalization the symlink key misses defRangesByRel → 0 edges.
    // With it, the resolved symlink path collapses to the realpath key → the edge lands.
    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call).toBeDefined();
    expect(call?.sourceNodeId).toBe('symbol:php:App\\Caller::run');
    expect(call?.targetNodeId).toBe('symbol:php:Kernel\\Repo::doThing');
    expect(call?.confidenceClass).toBe('proven');
  });

  it('degrades a dangling-symlink target to a drop without crashing, while a valid target in the same run still resolves', async () => {
    const root2 = join(base, 'root2');
    mkdirSync(join(root2, 'app'), { recursive: true });
    mkdirSync(join(root2, 'vendor'), { recursive: true });
    // Two member calls: `$other->ok()` (line 4) resolves to a real in-corpus file;
    // `$repo->doThing()` (line 5) resolves under a dangling symlink.
    writeFileSync(
      join(root2, 'app', 'Caller.php'),
      [
        '<?php',
        'namespace App;',
        'class Caller {',
        '  function run($repo, $other) {',
        '    $other->ok();',
        '    $repo->doThing();',
        '  }',
        '}',
      ].join('\n')
    );
    writeFileSync(
      join(root2, 'app', 'Repo.php'),
      ['<?php', 'namespace App;', 'class Repo {', '  function ok() {}', '}'].join('\n')
    );
    // A symlink whose target does not exist — realpathSync(dirname) throws → canon degrades to raw.
    symlinkSync(join(base, 'does-not-exist'), join(root2, 'vendor', 'broken'));

    const entries = [
      { filePath: join(root2, 'app', 'Caller.php') },
      { filePath: join(root2, 'app', 'Repo.php') },
    ].map((e) => ({ ...e, content: readFileSync(e.filePath, 'utf8') }));

    const resolveDefinition: ResolveDefinition = (file, line) => {
      if (file !== join(root2, 'app', 'Caller.php')) return Promise.resolve(null);
      if (line === 4) return Promise.resolve({ filePath: join(root2, 'app', 'Repo.php'), line: 3 }); // ok()
      if (line === 5)
        return Promise.resolve({ filePath: join(root2, 'vendor', 'broken', 'Repo.php'), line: 0 }); // dangling
      return Promise.resolve(null);
    };

    // Must complete (no throw): the dangling target is dropped, but the valid one still lands —
    // proving the pass got PAST canonPath's caught throw rather than aborting.
    const edges = await resolveTypedReceiverEdges(entries, root2, resolveDefinition, 1000);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceNodeId).toBe('symbol:php:App\\Caller::run');
    expect(edges[0].targetNodeId).toBe('symbol:php:App\\Repo::ok');
  });

  it('preserves in-corpus keys when the CORPUS ROOT itself is a symlink (rootPathReal)', async () => {
    // The scan keys app files by the symlinked-root form (GeneralScanner uses
    // join(rootPath, file) with no realpath); the LSP resolves through the real root.
    // Only canonicalizing rootPath (rootPathReal) keeps the two in the same key space.
    const realRoot = join(base, 'realroot');
    mkdirSync(join(realRoot, 'app'), { recursive: true });
    writeFileSync(
      join(realRoot, 'app', 'Svc.php'),
      [
        '<?php',
        'namespace App;',
        'class Svc {',
        '  function run($repo) { $repo->find(); }',
        '}',
      ].join('\n')
    );
    writeFileSync(
      join(realRoot, 'app', 'Repo.php'),
      ['<?php', 'namespace App;', 'class Repo {', '  function find() {}', '}'].join('\n')
    );
    const symRoot = join(base, 'symroot');
    symlinkSync(realRoot, symRoot); // the corpus root passed to the pass is a symlink

    const entries = [
      { filePath: join(symRoot, 'app', 'Svc.php') },
      { filePath: join(symRoot, 'app', 'Repo.php') },
    ].map((e) => ({ ...e, content: readFileSync(e.filePath, 'utf8') }));

    // The LSP resolves `find` through the REAL root (realpath'd), not the symlink.
    const resolveDefinition: ResolveDefinition = (file) =>
      Promise.resolve(
        file === join(symRoot, 'app', 'Svc.php')
          ? { filePath: join(realRoot, 'app', 'Repo.php'), line: 3 }
          : null
      );

    // Without rootPathReal, toRelative(realRoot/app/Repo.php, symRoot) would not strip → key miss.
    const edges = await resolveTypedReceiverEdges(entries, symRoot, resolveDefinition, 1000);
    const call = edges.find((e) => e.edgeType === 'calls');
    expect(call).toBeDefined();
    expect(call?.sourceNodeId).toBe('symbol:php:App\\Svc::run');
    expect(call?.targetNodeId).toBe('symbol:php:App\\Repo::find');
  });
});
