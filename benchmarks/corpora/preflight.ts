import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { devNull, homedir, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CorpusManifestEntryV1 {
  id: string;
  remote: string;
  checkoutHints: string[];
  commit: string;
  fixtureSchemaVersion: number;
  goldSchemaVersion: number;
  minimumCases: number;
}

export interface CorpusManifestV1 {
  schemaVersion: 1;
  owner: string;
  corpora: CorpusManifestEntryV1[];
}

export interface CorpusResolutionV1 {
  id: string;
  rootPath: string;
  remote: string;
  commit: string;
  owner: string;
  isolated: boolean;
}

export type CorpusPreflightCode =
  | 'corpus.schema-unsupported'
  | 'corpus.owner-missing'
  | 'corpus.id-missing'
  | 'corpus.checkout-missing'
  | 'corpus.checkout-invalid'
  | 'corpus.path-unsafe'
  | 'corpus.remote-mismatch'
  | 'corpus.commit-unreachable'
  | 'corpus.isolation-required'
  | 'corpus.submodule-unsupported'
  | 'corpus.symlink-unsafe'
  | 'corpus.isolation-failed'
  | 'corpus.cleanup-failed';

export class CorpusPreflightError extends Error {
  readonly code: CorpusPreflightCode;
  readonly details?: Readonly<Record<string, string>>;

  constructor(
    code: CorpusPreflightCode,
    message: string,
    details?: Readonly<Record<string, string>>
  ) {
    super(message);
    this.name = 'CorpusPreflightError';
    this.code = code;
    this.details = details;
  }
}

interface CorpusPreflightCommonOptionsV1 {
  manifestPath?: string;
  checkoutOverrides?: Readonly<Record<string, string>>;
  homeDirectory?: string;
  allowedCheckoutRoots?: readonly string[];
  /** Omitted, `always`, and legacy `when-needed` create a snapshot; legacy `never` is refused. */
  isolation?: 'always' | 'when-needed' | 'never';
  isolationRoot?: string;
}

export interface CorpusPreflightOptionsV1 extends CorpusPreflightCommonOptionsV1 {
  corpusId: string;
}

export interface CorpusBatchPreflightOptionsV1 extends CorpusPreflightCommonOptionsV1 {
  corpusIds: readonly string[];
}

export interface PreparedCorpusV1 {
  resolution: CorpusResolutionV1;
  cleanup(): void;
}

export interface PreparedCorporaV1 {
  resolutions: readonly CorpusResolutionV1[];
  cleanup(): void;
}

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS_MANIFEST = join(MODULE_DIRECTORY, 'manifest.json');
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const EXACT_COMMIT = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER_MAX = 2_147_483_647;
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}
const GIT_TIMEOUT_MS = 15_000;

const GIT_ENV: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_ALLOW_PROTOCOL: 'file',
};

const SAFE_GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'core.attributesFile=/dev/null',
] as const;

function fail(
  code: CorpusPreflightCode,
  message: string,
  details?: Readonly<Record<string, string>>
): never {
  throw new CorpusPreflightError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPositiveVersion(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= POSITIVE_INTEGER_MAX
  );
}

/** IDs shared with corpus/case fixtures are deliberately safe as one path component. */
export function isPathSafeCorpusOrCaseId(value: string): boolean {
  return SAFE_ID.test(value);
}

/** Accept only the three explicit GitHub transport spellings in the corpus contract. */
export function normalizeGitHubRemote(remote: string): string | undefined {
  if (hasControlCharacter(remote) || !/^[\x20-\x7e]+$/u.test(remote)) return undefined;

  const patterns = [
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u,
  ] as const;
  for (const pattern of patterns) {
    const match = pattern.exec(remote);
    if (!match) continue;
    const owner = match[1];
    const repository = match[2];
    if (owner === '.' || owner === '..' || repository === '.' || repository === '..') {
      return undefined;
    }
    return `${owner}/${repository}`.toLowerCase();
  }
  return undefined;
}

/** Read and strictly validate a v1 corpus manifest. Unknown fields are schema drift. */
export function loadCorpusManifest(manifestPath = DEFAULT_CORPUS_MANIFEST): CorpusManifestV1 {
  let parsed: unknown;
  try {
    if (lstatSync(manifestPath).isSymbolicLink()) {
      fail('corpus.path-unsafe', 'Corpus manifest must not be a symbolic link');
    }
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof CorpusPreflightError) throw error;
    fail('corpus.schema-unsupported', 'Corpus manifest could not be read as JSON');
  }

  if (!isRecord(parsed)) {
    fail('corpus.schema-unsupported', 'Corpus manifest does not match schema version 1');
  }
  if (parsed.schemaVersion !== 1) {
    fail('corpus.schema-unsupported', 'Unsupported corpus manifest schema version');
  }
  if (typeof parsed.owner !== 'string' || parsed.owner.trim().length === 0) {
    fail('corpus.owner-missing', 'Corpus manifest requires a non-empty fixture/gold owner');
  }
  if (!hasExactKeys(parsed, ['schemaVersion', 'owner', 'corpora'])) {
    fail('corpus.schema-unsupported', 'Corpus manifest does not match schema version 1');
  }
  if (!Array.isArray(parsed.corpora) || parsed.corpora.length === 0) {
    fail('corpus.schema-unsupported', 'Corpus manifest requires at least one corpus');
  }

  const ids = new Set<string>();
  const corpora: CorpusManifestEntryV1[] = parsed.corpora.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        'id',
        'remote',
        'checkoutHints',
        'commit',
        'fixtureSchemaVersion',
        'goldSchemaVersion',
        'minimumCases',
      ]) ||
      typeof candidate.id !== 'string' ||
      !isPathSafeCorpusOrCaseId(candidate.id) ||
      typeof candidate.remote !== 'string' ||
      normalizeGitHubRemote(candidate.remote) === undefined ||
      !Array.isArray(candidate.checkoutHints) ||
      candidate.checkoutHints.length === 0 ||
      !candidate.checkoutHints.every(
        (hint): hint is string => typeof hint === 'string' && hint.length > 0
      ) ||
      new Set(candidate.checkoutHints).size !== candidate.checkoutHints.length ||
      typeof candidate.commit !== 'string' ||
      !EXACT_COMMIT.test(candidate.commit) ||
      !isPositiveVersion(candidate.fixtureSchemaVersion) ||
      !isPositiveVersion(candidate.goldSchemaVersion) ||
      !isPositiveVersion(candidate.minimumCases)
    ) {
      fail('corpus.schema-unsupported', 'Corpus manifest entry does not match schema version 1');
    }
    if (ids.has(candidate.id)) {
      fail('corpus.schema-unsupported', `Duplicate corpus id: ${candidate.id}`);
    }
    ids.add(candidate.id);
    return {
      id: candidate.id,
      remote: candidate.remote,
      checkoutHints: [...candidate.checkoutHints],
      commit: candidate.commit,
      fixtureSchemaVersion: candidate.fixtureSchemaVersion,
      goldSchemaVersion: candidate.goldSchemaVersion,
      minimumCases: candidate.minimumCases,
    };
  });

  return { schemaVersion: 1, owner: parsed.owner.trim(), corpora };
}

function expandCheckoutPath(value: string, homeDirectory: string, baseDirectory: string): string {
  if (hasControlCharacter(value) || value.length === 0) {
    fail('corpus.path-unsafe', 'Checkout path contains a control character or is empty');
  }
  if (value.split(/[\\/]/u).includes('..')) {
    fail('corpus.path-unsafe', 'Checkout path traversal is not allowed');
  }

  let expanded: string;
  if (value === '~') {
    expanded = homeDirectory;
  } else if (value.startsWith(`~${sep}`) || value.startsWith('~/')) {
    expanded = join(homeDirectory, value.slice(2));
  } else if (value.startsWith('~')) {
    fail('corpus.path-unsafe', 'Named-user home expansion is not supported');
  } else {
    expanded = isAbsolute(value) ? value : resolve(baseDirectory, value);
  }
  return resolve(expanded);
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function assertNoSymlinkComponents(path: string, boundary: string): void {
  const inputBoundary = resolve(boundary);
  const inputPath = resolve(path);
  if (!isInside(inputBoundary, inputPath)) {
    fail('corpus.path-unsafe', 'Checkout path is outside the allowed root');
  }
  const parts = relative(inputBoundary, inputPath).split(sep).filter(Boolean);
  let current = realpathSync(inputBoundary);
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      fail('corpus.path-unsafe', `Checkout path contains a symbolic-link component: ${current}`);
    }
  }
}

function confineCheckout(path: string, allowedRoots: readonly string[]): string {
  if (allowedRoots.length === 0) {
    if (lstatSync(path).isSymbolicLink()) {
      fail('corpus.path-unsafe', 'Checkout path must not be a symbolic link');
    }
    return realpathSync(path);
  }

  const boundary = allowedRoots.find((root) => isInside(resolve(root), resolve(path)));
  if (!boundary) {
    fail('corpus.path-unsafe', 'Checkout path is outside the allowed roots');
  }
  assertNoSymlinkComponents(path, boundary);
  const canonicalBoundary = realpathSync(boundary);
  const canonical = realpathSync(path);
  if (!isInside(canonicalBoundary, canonical)) {
    fail('corpus.path-unsafe', 'Checkout path resolves outside the allowed root');
  }
  return canonical;
}

function git(cwd: string | undefined, args: readonly string[]): string {
  const command = [...SAFE_GIT_CONFIG, ...(cwd ? ['-C', cwd] : []), ...args];
  return execFileSync('git', command, {
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function gitTrimmed(cwd: string | undefined, args: readonly string[]): string {
  return git(cwd, args).trim();
}

function validateCheckoutRoot(path: string): void {
  let topLevel: string;
  try {
    topLevel = realpathSync(gitTrimmed(path, ['rev-parse', '--show-toplevel']));
  } catch {
    fail('corpus.checkout-invalid', 'Checkout is not a readable Git worktree', { path });
  }
  if (topLevel !== path) {
    fail('corpus.checkout-invalid', 'Checkout hint must identify the Git worktree root', { path });
  }
  const gitMarker = join(path, '.git');
  if (!existsSync(gitMarker) || lstatSync(gitMarker).isSymbolicLink()) {
    fail('corpus.path-unsafe', 'Checkout .git marker is missing or is a symbolic link', { path });
  }
}

function currentCommit(path: string): string {
  try {
    const head = gitTrimmed(path, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!EXACT_COMMIT.test(head)) throw new Error('Non-canonical HEAD');
    return head;
  } catch {
    fail('corpus.checkout-invalid', 'Checkout HEAD is not a commit');
  }
}

function resolvePinnedCommit(path: string, pinned: string): string {
  try {
    const type = gitTrimmed(path, ['cat-file', '-t', '--', pinned]);
    if (type !== 'commit') {
      fail('corpus.commit-unreachable', 'Pinned object is not exactly a commit', { pinned, type });
    }
    const resolved = gitTrimmed(path, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${pinned}^{commit}`,
    ]);
    if (resolved !== pinned) {
      fail('corpus.commit-unreachable', 'Pinned commit did not resolve to the exact OID', {
        pinned,
        resolved,
      });
    }

    if (currentCommit(path) !== pinned) {
      const containingRefs = gitTrimmed(path, [
        'for-each-ref',
        '--format=%(refname)',
        `--contains=${pinned}`,
        'refs/heads',
        'refs/remotes',
      ]);
      if (containingRefs.length === 0) {
        fail(
          'corpus.commit-unreachable',
          'Pinned commit is not reachable from HEAD or a local ref',
          {
            pinned,
          }
        );
      }
    }
    return pinned;
  } catch (error) {
    if (error instanceof CorpusPreflightError) throw error;
    fail('corpus.commit-unreachable', 'Pinned commit is not reachable from the checkout', {
      pinned,
    });
  }
}

interface TrackedTreeEntry {
  mode: string;
  oid: string;
  path: string;
}

function readTrackedTree(path: string, commit: string): Map<string, TrackedTreeEntry> {
  let tree: string;
  try {
    tree = git(path, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  } catch {
    fail('corpus.commit-unreachable', 'Pinned commit tree could not be inspected', { commit });
  }

  const entries = new Map<string, TrackedTreeEntry>();
  for (const raw of tree.split('\0')) {
    if (raw.length === 0) continue;
    const match = /^(\d{6}) [^ ]+ ([0-9a-f]{40,64})\t([\s\S]+)$/u.exec(raw);
    if (!match) {
      fail('corpus.symlink-unsafe', 'Pinned commit contains an unreadable tree entry');
    }
    const entry = { mode: match[1], oid: match[2], path: match[3] };
    if (entry.mode === '160000') {
      fail('corpus.submodule-unsupported', 'Pinned commit contains an unsupported submodule', {
        path: entry.path,
      });
    }
    entries.set(entry.path, entry);
  }
  return entries;
}

function readSymlinkTarget(repository: string, entry: TrackedTreeEntry): string {
  let blob: Buffer;
  try {
    blob = execFileSync(
      'git',
      [...SAFE_GIT_CONFIG, '-C', repository, 'cat-file', 'blob', entry.oid],
      {
        encoding: 'buffer',
        env: GIT_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      }
    );
  } catch {
    fail('corpus.symlink-unsafe', 'Tracked symbolic-link target could not be read', {
      path: entry.path,
    });
  }

  let target: string;
  try {
    target = new TextDecoder('utf-8', { fatal: true }).decode(blob);
  } catch {
    fail('corpus.symlink-unsafe', 'Tracked symbolic-link target is not valid UTF-8', {
      path: entry.path,
    });
  }
  if (target.length === 0 || hasControlCharacter(target)) {
    fail(
      'corpus.symlink-unsafe',
      'Tracked symbolic-link target is empty or contains a control character',
      {
        path: entry.path,
      }
    );
  }
  if (posix.isAbsolute(target) || win32.isAbsolute(target)) {
    fail('corpus.symlink-unsafe', 'Tracked symbolic-link target must be relative', {
      path: entry.path,
      target,
    });
  }
  return target;
}

function lexicalSymlinkDestination(linkPath: string, target: string): string {
  // Git paths are slash-separated. Treat backslashes as separators too so a snapshot accepted on
  // POSIX cannot become an escape when consumed on Windows.
  const portableTarget = target.replaceAll('\\', '/');
  const destination = posix.normalize(posix.join(posix.dirname(linkPath), portableTarget));
  if (
    destination === '..' ||
    destination.startsWith('../') ||
    posix.isAbsolute(destination) ||
    win32.isAbsolute(destination)
  ) {
    fail('corpus.symlink-unsafe', 'Tracked symbolic link lexically escapes the corpus root', {
      path: linkPath,
      target,
    });
  }
  return destination === '.' ? '' : destination;
}

/**
 * Inspect targets from Git blobs, without dereferencing source-worktree links. Return the tracked
 * links so their checked-out realpaths can be verified only after an isolated checkout exists.
 */
function validateTrackedSymlinks(path: string, commit: string): readonly string[] {
  const entries = readTrackedTree(path, commit);
  const targets = new Map<string, string>();
  for (const entry of entries.values()) {
    if (entry.mode === '120000') {
      const target = readSymlinkTarget(path, entry);
      lexicalSymlinkDestination(entry.path, target);
      targets.set(entry.path, target);
    }
  }

  const resolveTreeDestination = (candidate: string, chain: ReadonlySet<string>): string => {
    const components = candidate === '' ? [] : candidate.split('/');
    for (let index = 0; index < components.length; index += 1) {
      const prefix = components.slice(0, index + 1).join('/');
      const target = targets.get(prefix);
      if (target === undefined) continue;
      if (chain.has(prefix)) {
        fail('corpus.symlink-unsafe', 'Tracked symbolic-link chain is cyclic', { path: prefix });
      }
      const next = lexicalSymlinkDestination(
        prefix,
        posix.join(target.replaceAll('\\', '/'), ...components.slice(index + 1))
      );
      return resolveTreeDestination(next, new Set([...chain, prefix]));
    }
    return candidate;
  };

  for (const [linkPath, target] of targets) {
    const destination = resolveTreeDestination(
      lexicalSymlinkDestination(linkPath, target),
      new Set([linkPath])
    );
    if (destination !== '' && !entries.has(destination)) {
      const directoryPrefix = `${destination}/`;
      if (![...entries.keys()].some((trackedPath) => trackedPath.startsWith(directoryPrefix))) {
        fail('corpus.symlink-unsafe', 'Tracked symbolic-link chain is broken', {
          path: linkPath,
          target,
        });
      }
    }
  }
  return [...targets.keys()];
}

function validateCheckedOutSymlinkRealpaths(root: string, symlinks: readonly string[]): void {
  const canonicalRoot = realpathSync(root);
  for (const linkPath of symlinks) {
    const checkedOutPath = join(root, ...linkPath.split('/'));
    let destination: string;
    try {
      destination = realpathSync(checkedOutPath);
    } catch {
      fail('corpus.symlink-unsafe', 'Checked-out symbolic-link chain is broken or cyclic', {
        path: linkPath,
      });
    }
    if (!isInside(canonicalRoot, destination)) {
      fail(
        'corpus.symlink-unsafe',
        'Checked-out symbolic link resolves outside the isolated root',
        {
          path: linkPath,
        }
      );
    }
  }
}

function isDirty(path: string): boolean {
  try {
    return (
      git(path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]).length > 0
    );
  } catch {
    fail('corpus.checkout-invalid', 'Checkout status could not be inspected');
  }
}

function verifyRemote(path: string, expectedRemote: string): string {
  const expected = normalizeGitHubRemote(expectedRemote);
  if (!expected) {
    fail('corpus.schema-unsupported', 'Manifest remote is not a supported GitHub remote');
  }

  let actualUrls: string[];
  try {
    actualUrls = git(path, ['remote', 'get-url', '--all', 'origin'])
      .split(/\r?\n/u)
      .filter((value) => value.length > 0);
  } catch {
    fail('corpus.remote-mismatch', 'Checkout has no readable origin remote', { expected });
  }
  if (actualUrls.length !== 1) {
    fail('corpus.remote-mismatch', 'Checkout must have exactly one unambiguous origin URL', {
      expected,
      count: String(actualUrls.length),
    });
  }
  const actual = normalizeGitHubRemote(actualUrls[0]);
  if (actual !== expected) {
    fail('corpus.remote-mismatch', 'Checkout origin does not match the manifest remote', {
      expected,
      actual: actual ?? 'unsupported',
    });
  }
  return expected;
}

function createIsolatedCheckout(input: {
  source: string;
  isolationRoot?: string;
  id: string;
  commit: string;
  remoteUrl: string;
}): { rootPath: string; cleanup: () => void } {
  const parent = resolve(input.isolationRoot ?? tmpdir());
  if (!existsSync(parent)) {
    fail('corpus.path-unsafe', 'Isolation root does not exist');
  }
  if (lstatSync(parent).isSymbolicLink()) {
    fail('corpus.path-unsafe', 'Isolation root must not be a symbolic link');
  }
  if (!lstatSync(parent).isDirectory()) {
    fail('corpus.path-unsafe', 'Isolation root is not a directory');
  }
  const canonicalParent = realpathSync(parent);
  const ownedPrefix = `lux-corpus-${input.id}-`;
  const container = mkdtempSync(join(canonicalParent, ownedPrefix));
  const checkout = join(container, 'checkout');
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    if (!isInside(canonicalParent, container) || !basename(container).startsWith(ownedPrefix)) {
      fail('corpus.cleanup-failed', 'Refusing to remove a non-owned isolation path');
    }
    try {
      rmSync(container, { recursive: true, force: true });
      cleaned = true;
    } catch {
      fail('corpus.cleanup-failed', 'Isolated corpus cleanup failed', { path: container });
    }
  };

  try {
    git(undefined, [
      'clone',
      '--local',
      '--no-hardlinks',
      '--no-checkout',
      '--',
      input.source,
      checkout,
    ]);
    git(checkout, ['remote', 'set-url', 'origin', input.remoteUrl]);
    const trackedSymlinks = validateTrackedSymlinks(checkout, input.commit);
    git(checkout, ['checkout', '--detach', input.commit]);
    const canonicalCheckout = confineCheckout(checkout, [container]);
    validateCheckoutRoot(canonicalCheckout);
    validateCheckedOutSymlinkRealpaths(canonicalCheckout, trackedSymlinks);
    const currentBranch = gitTrimmed(canonicalCheckout, ['branch', '--show-current']);
    if (
      currentBranch.length !== 0 ||
      currentCommit(canonicalCheckout) !== input.commit ||
      isDirty(canonicalCheckout)
    ) {
      fail('corpus.isolation-failed', 'Isolated checkout is not clean and detached at the pin');
    }

    // This is intentionally the final operation before exposure: revalidate the detached HEAD,
    // exact tree, and clean worktree after every other checkout/scanning validation has completed.
    const finalHead = currentCommit(canonicalCheckout);
    const finalTree = gitTrimmed(canonicalCheckout, ['rev-parse', '--verify', 'HEAD^{tree}']);
    const pinnedTree = gitTrimmed(canonicalCheckout, [
      'rev-parse',
      '--verify',
      `${input.commit}^{tree}`,
    ]);
    if (finalHead !== input.commit || finalTree !== pinnedTree || isDirty(canonicalCheckout)) {
      fail('corpus.isolation-failed', 'Isolated checkout changed during final revalidation');
    }
    return { rootPath: canonicalCheckout, cleanup };
  } catch (error) {
    cleanup();
    if (error instanceof CorpusPreflightError) throw error;
    fail('corpus.isolation-failed', 'Could not create isolated detached checkout');
  }
}

function validateOverrides(
  overrides: Readonly<Record<string, string>> | undefined,
  manifest: CorpusManifestV1
): void {
  if (overrides === undefined) return;
  if (!isRecord(overrides)) {
    fail('corpus.path-unsafe', 'Checkout overrides must be a path-only record');
  }
  const knownIds = new Set(manifest.corpora.map(({ id }) => id));
  for (const [id, value] of Object.entries(overrides)) {
    if (!knownIds.has(id)) {
      fail('corpus.id-missing', `Checkout override names an unknown corpus: ${id}`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      fail('corpus.path-unsafe', `Checkout override is not a path for corpus: ${id}`);
    }
  }
}

function prepareFromManifest(
  options: CorpusPreflightCommonOptionsV1,
  manifestPath: string,
  manifest: CorpusManifestV1,
  corpusId: string
): PreparedCorpusV1 {
  if (!isPathSafeCorpusOrCaseId(corpusId)) {
    fail('corpus.id-missing', 'Corpus ID must be one path-safe manifest identity');
  }
  const corpus = manifest.corpora.find(({ id }) => id === corpusId);
  if (!corpus) fail('corpus.id-missing', `Corpus is not present in the manifest: ${corpusId}`);

  const override = options.checkoutOverrides?.[corpus.id];
  const candidates = override === undefined ? corpus.checkoutHints : [override];
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const baseDirectory = dirname(manifestPath);
  const allowedRoots = (options.allowedCheckoutRoots ?? []).map((root) => {
    if (typeof root !== 'string') {
      fail('corpus.path-unsafe', 'Allowed checkout roots must contain paths only');
    }
    const expanded = expandCheckoutPath(root, homeDirectory, baseDirectory);
    if (!existsSync(expanded)) {
      fail('corpus.path-unsafe', 'Allowed checkout root does not exist');
    }
    return expanded;
  });
  const candidate = candidates
    .map((hint) => expandCheckoutPath(hint, homeDirectory, baseDirectory))
    .find((path) => existsSync(path));
  if (!candidate) {
    fail('corpus.checkout-missing', `No checkout exists for corpus: ${corpus.id}`);
  }

  let source: string;
  try {
    source = confineCheckout(candidate, allowedRoots);
  } catch (error) {
    if (error instanceof CorpusPreflightError) throw error;
    fail('corpus.path-unsafe', 'Checkout path could not be safely resolved');
  }
  validateCheckoutRoot(source);
  const remote = verifyRemote(source, corpus.remote);
  const commit = resolvePinnedCommit(source, corpus.commit);
  validateTrackedSymlinks(source, commit);

  // Every caller receives an owned snapshot. `when-needed` remains accepted for API compatibility,
  // but deliberately has the same scanner-safe behavior as `always`; mutable source worktrees are
  // never exposed as benchmark roots.
  const prepared = createIsolatedCheckout({
    source,
    isolationRoot: options.isolationRoot,
    id: corpus.id,
    commit,
    remoteUrl: corpus.remote,
  });
  const rootPath = prepared.rootPath;
  const cleanup = prepared.cleanup;

  return {
    resolution: {
      id: corpus.id,
      rootPath,
      remote,
      commit,
      owner: manifest.owner,
      isolated: true,
    },
    cleanup,
  };
}

/** Validate one corpus completely before exposing a scanner-safe root. */
export function preflightCorpus(options: CorpusPreflightOptionsV1): PreparedCorpusV1 {
  if (options.isolation === 'never') {
    fail('corpus.isolation-required', 'Corpus preflight requires an owned isolated snapshot');
  }
  const manifestPath = resolve(options.manifestPath ?? DEFAULT_CORPUS_MANIFEST);
  const manifest = loadCorpusManifest(manifestPath);
  validateOverrides(options.checkoutOverrides, manifest);
  return prepareFromManifest(options, manifestPath, manifest, options.corpusId);
}

/**
 * Global barrier: resolve every selected corpus or return none. A later failure rolls back all
 * earlier isolated resources before it is observed by a benchmark operation.
 */
export function preflightCorpora(options: CorpusBatchPreflightOptionsV1): PreparedCorporaV1 {
  if (options.isolation === 'never') {
    fail('corpus.isolation-required', 'Corpus preflight requires owned isolated snapshots');
  }
  const manifestPath = resolve(options.manifestPath ?? DEFAULT_CORPUS_MANIFEST);
  const manifest = loadCorpusManifest(manifestPath);
  validateOverrides(options.checkoutOverrides, manifest);
  if (
    !Array.isArray(options.corpusIds) ||
    options.corpusIds.length === 0 ||
    options.corpusIds.some((id) => typeof id !== 'string' || !isPathSafeCorpusOrCaseId(id)) ||
    new Set(options.corpusIds).size !== options.corpusIds.length
  ) {
    fail('corpus.id-missing', 'Selected corpus IDs must be a non-empty unique path-safe list');
  }
  const corpusIds: readonly string[] = options.corpusIds;
  const prepared: PreparedCorpusV1[] = [];
  try {
    for (const corpusId of corpusIds) {
      prepared.push(prepareFromManifest(options, manifestPath, manifest, corpusId));
    }
  } catch (error) {
    let cleanupError: unknown;
    for (const item of [...prepared].reverse()) {
      try {
        item.cleanup();
      } catch (candidate) {
        cleanupError ??= candidate;
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
    throw error;
  }

  let cleaned = false;
  return {
    resolutions: prepared.map(({ resolution }) => resolution),
    cleanup: () => {
      if (cleaned) return;
      let cleanupError: unknown;
      for (const item of [...prepared].reverse()) {
        try {
          item.cleanup();
        } catch (candidate) {
          cleanupError ??= candidate;
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
      cleaned = true;
    },
  };
}

/** Run one operation only after preflight, with guaranteed idempotent cleanup. */
export async function withPreflightCorpus<T>(
  options: CorpusPreflightOptionsV1,
  operation: (resolution: CorpusResolutionV1) => T | Promise<T>
): Promise<T> {
  const prepared = preflightCorpus(options);
  try {
    return await operation(prepared.resolution);
  } finally {
    prepared.cleanup();
  }
}

/** Run one operation only after the all-corpora global barrier has succeeded. */
export async function withPreflightCorpora<T>(
  options: CorpusBatchPreflightOptionsV1,
  operation: (resolutions: readonly CorpusResolutionV1[]) => T | Promise<T>
): Promise<T> {
  const prepared = preflightCorpora(options);
  try {
    return await operation(prepared.resolutions);
  } finally {
    prepared.cleanup();
  }
}
