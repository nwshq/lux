#!/usr/bin/env npx tsx
/**
 * verify-native-free.ts — permanent CI feasibility gate (Decision 3, Phase 3 / T3.1).
 *
 * Bright line (18-SPEC-FENCE-AND-NATIVE-FREE-CI.md §Part 2/A): on a clean PRODUCTION install
 * (`npm ci --omit=dev`), transitively, there must be zero of:
 *   - files named `*.node` anywhere under node_modules (a native addon);
 *   - installed packages whose own package.json declares a non-empty `os` or `cpu` array
 *     (a package that only installs on some platforms — the onnxruntime-node/sharp class);
 *   - installed packages/directories matching the npm platform-package naming convention
 *     (`<platform>-<arch>`, e.g. `@esbuild/linux-x64`, `lightningcss-darwin-arm64`), even when
 *     a package omits the os/cpu fields.
 *
 * This check installs a FRESH, isolated production tree in a temp directory (a copy of this
 * repo's package.json + package-lock.json, `npm ci --omit=dev`) rather than filtering the repo's
 * own node_modules, so devDependencies (which today include a real *.node binary —
 * better-sqlite3, package.json:66 — plus three platform-scoped optional devDependencies pulled in
 * transitively by the test tooling) can never contaminate the answer. See the spec's "Why a
 * clean-room install" for the concrete evidence that ruled out closure-filtering instead.
 *
 * Usage:
 *   npx tsx scripts/verify-native-free.ts [--json] [--verbose] [--keep-temp]
 *
 * Exit codes:
 *   0 — clean production install tree, zero violations
 *   1 — one or more violations found, OR the clean-room install itself failed
 */

import { execFileSync } from 'node:child_process';
import {
  type Dirent,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const PACKAGE_JSON = resolve(ROOT, 'package.json');
const PACKAGE_LOCK = resolve(ROOT, 'package-lock.json');

/**
 * Platform tokens used by the npm prebuilt-native-binary package-naming convention
 * (e.g. `@esbuild/linux-x64`, `lightningcss-darwin-arm64`, `@rollup/rollup-win32-x64-msvc`).
 */
const PLATFORM_TOKENS = [
  'darwin', 'linux', 'win32', 'android', 'freebsd', 'openbsd', 'sunos', 'aix',
] as const;

/** Architecture tokens that pair with a platform token in that same convention. */
const ARCH_TOKENS = [
  'x64', 'ia32', 'arm64', 'arm', 'ppc64', 'ppc64le', 's390x', 'mips64el', 'riscv64', 'universal',
] as const;

/**
 * Matches `<platform>-<arch>` (optionally followed by an ABI suffix — `-gnu`, `-musl`, `-msvc`, …)
 * at the end of a package name or directory basename. Requires BOTH a platform token and an arch
 * token together, so an unrelated package whose name merely contains "linux" or "win32" cannot
 * false-positive. This is a second, independent signal alongside the os/cpu field check, for a
 * platform package that omits those fields.
 */
const PLATFORM_PACKAGE_NAME_RE = new RegExp(
  `(?:^|[-/])(?:${PLATFORM_TOKENS.join('|')})-(?:${ARCH_TOKENS.join('|')})(?:-[a-z0-9]+)?$`,
  'i',
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ViolationKind = 'native-addon' | 'platform-scoped-package';

export interface Violation {
  kind: ViolationKind;
  /** Path relative to the scanned node_modules root. */
  path: string;
  /** Human-readable reason(s); joined with "; " when a package trips more than one signal. */
  detail: string;
}

interface MinimalPackageJson {
  name?: unknown;
  os?: unknown;
  cpu?: unknown;
}

// ---------------------------------------------------------------------------
// Step 1 — clean-room production install
// ---------------------------------------------------------------------------

/**
 * Reproduces exactly what a downstream consumer's `npm i --omit=dev` would install: a fresh temp
 * directory seeded with THIS repo's package.json + package-lock.json, then `npm ci --omit=dev`.
 *
 * Deliberately NOT `--omit=optional`: an optionalDependency that npm installs because it matches
 * the current platform (the esbuild/sharp/lightningcss pattern — an os/cpu-scoped package
 * declared optional so the *wrapper* doesn't fail to install on other platforms) is exactly the
 * failure class this check exists to catch. Passing `--omit=optional` would make npm silently
 * skip installing it and blind the scan to it — the opposite of the audit's job.
 */
function installProductionTree(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'lux-native-free-'));
  copyFileSync(PACKAGE_JSON, join(tempDir, 'package.json'));
  copyFileSync(PACKAGE_LOCK, join(tempDir, 'package-lock.json'));

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    execFileSync(npmCmd, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: tempDir,
      stdio: 'inherit',
    });
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    console.error('\nverify-native-free: clean production install failed (see npm output above).');
    throw error;
  }
  return tempDir;
}

// ---------------------------------------------------------------------------
// Step 2 — scan the installed tree
// ---------------------------------------------------------------------------

/**
 * Recursively scans a node_modules tree for native addons and platform-scoped packages.
 *
 * Exported (and `main()` guarded below, same pattern as `ast-extract.ts`) so a fixture test can
 * call this directly against a planted directory without paying for a real npm install — e.g. a
 * fixture containing a planted `foo.node` file, or a package.json with `"os": ["darwin"]`, must
 * make `scanTree(fixtureDir)` return a non-empty violation list.
 *
 * Robustness: an unreadable directory or a malformed package.json is skipped, never thrown; a
 * symlink (chiefly node_modules/.bin/*) is followed but de-duplicated by real path so a cycle, or
 * many links to the same real target, cannot spin the walk forever or double-report.
 */
export function scanTree(nodeModulesRoot: string): Violation[] {
  const violations: Violation[] = [];
  const visitedRealPaths = new Set<string>();

  function checkPackageJson(filePath: string): void {
    let pkg: MinimalPackageJson;
    try {
      pkg = JSON.parse(readFileSync(filePath, 'utf8')) as MinimalPackageJson;
    } catch {
      return; // unreadable/malformed package.json — skip rather than crash
    }

    const reasons: string[] = [];

    const os = Array.isArray(pkg.os) ? (pkg.os as unknown[]) : undefined;
    if (os && os.length > 0) reasons.push(`os: ${JSON.stringify(os)}`);

    const cpu = Array.isArray(pkg.cpu) ? (pkg.cpu as unknown[]) : undefined;
    if (cpu && cpu.length > 0) reasons.push(`cpu: ${JSON.stringify(cpu)}`);

    const declaredName = typeof pkg.name === 'string' ? pkg.name : undefined;
    const unscopedName = declaredName?.includes('/') ? declaredName.split('/').pop() : declaredName;
    const dirName = basename(resolve(filePath, '..'));
    const nameCandidates = [unscopedName, dirName].filter(
      (n): n is string => typeof n === 'string' && n.length > 0,
    );
    const matchedName = nameCandidates.find((n) => PLATFORM_PACKAGE_NAME_RE.test(n));
    if (matchedName) {
      reasons.push(`name "${matchedName}" matches the platform-package naming convention`);
    }

    if (reasons.length > 0) {
      violations.push({
        kind: 'platform-scoped-package',
        path: relative(nodeModulesRoot, filePath),
        detail: reasons.join('; '),
      });
    }
  }

  function checkFile(filePath: string): void {
    const name = basename(filePath);
    if (name.endsWith('.node')) {
      violations.push({
        kind: 'native-addon',
        path: relative(nodeModulesRoot, filePath),
        detail: 'native addon binary (*.node) — forbidden under the WASM-only posture',
      });
      return;
    }
    if (name === 'package.json') {
      checkPackageJson(filePath);
    }
  }

  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip rather than crash
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(entryPath);
        } catch {
          continue; // broken symlink
        }
        if (visitedRealPaths.has(real)) continue; // cycle / repeat-target guard
        visitedRealPaths.add(real);

        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(entryPath); // follows the symlink
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(entryPath);
        else if (st.isFile()) checkFile(entryPath);
        continue;
      }

      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (entry.isFile()) {
        checkFile(entryPath);
      }
    }
  }

  if (existsSync(nodeModulesRoot)) {
    walk(nodeModulesRoot);
  }
  return dedupeViolations(violations);
}

function dedupeViolations(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of violations) {
    const key = `${v.kind}:${v.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 3 — report
// ---------------------------------------------------------------------------

function report(violations: Violation[], opts: { json: boolean }): void {
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          violations,
          summary: { violationCount: violations.length, clean: violations.length === 0 },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (violations.length === 0) {
    console.log(
      'Native-free check passed. Zero native addons, zero platform-scoped packages in the production install tree.',
    );
    return;
  }

  console.error('\nNative-free violations found:\n');
  for (const v of violations) {
    console.error(`  node_modules/${v.path}`);
    console.error(`    [${v.kind}] ${v.detail}`);
    console.error('');
  }
  console.error(
    `${violations.length} violation(s). The production install tree is NOT native-free — ` +
      'remove or replace the offending dependency (18-SPEC-FENCE-AND-NATIVE-FREE-CI.md Part 2/A).',
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const verbose = args.includes('--verbose');
  const keepTemp = args.includes('--keep-temp');

  if (!existsSync(PACKAGE_JSON) || !existsSync(PACKAGE_LOCK)) {
    console.error('verify-native-free: package.json/package-lock.json not found at repo root.');
    process.exitCode = 1;
    return;
  }

  let tempDir: string;
  try {
    tempDir = installProductionTree();
  } catch {
    process.exitCode = 1;
    return;
  }

  try {
    const violations = scanTree(join(tempDir, 'node_modules'));
    report(violations, { json: jsonOutput });
    if (verbose && !jsonOutput) {
      console.log(`\n(scanned production install at ${tempDir})`);
    }
    process.exitCode = violations.length > 0 ? 1 : 0;
  } finally {
    if (keepTemp) {
      console.error(`(--keep-temp: install left at ${tempDir})`);
    } else {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

const isEntryPoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntryPoint) {
  main();
}
