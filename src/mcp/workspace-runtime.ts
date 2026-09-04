import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LuxDatabase } from '../db/index.js';
import { resolveRuntimePaths, type RuntimePathResolution } from '../utils/runtime-paths.js';

export interface McpRoot {
  uri: string;
  name?: string;
}

export type ListRoots = () => Promise<{ roots: McpRoot[] }>;

export interface WorkspaceLease {
  runtime: RuntimePathResolution;
  db: LuxDatabase;
  release: () => void;
}

export interface WorkspaceRuntimeOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  openDatabase?: (dbPath: string) => LuxDatabase;
}

export type WorkspaceUnavailableReason =
  | 'initializing'
  | 'roots-list-failed'
  | 'roots-empty'
  | 'roots-ambiguous'
  | 'root-uri-invalid'
  | 'root-not-directory'
  | 'database-open-failed';

export class WorkspaceUnavailableError extends Error {
  readonly code = 'workspace-unavailable';

  constructor(
    readonly reason: WorkspaceUnavailableReason,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WorkspaceUnavailableError';
  }
}

interface WorkspaceHandle {
  runtime: RuntimePathResolution;
  db: LuxDatabase;
  leases: number;
  retired: boolean;
}

/**
 * Owns the long-lived Lux database handle used by the MCP server.
 *
 * An explicit LUX_CORPUS_PATH or LUX_DB_PATH is an operator override and keeps the server fixed to
 * that runtime. Otherwise a roots-capable MCP client selects the active corpus. Root changes swap
 * handles atomically: existing calls finish on their leased handle, while new calls wait for the
 * latest roots/list response and then use the new repository.
 */
export class WorkspaceRuntime {
  private readonly env: Record<string, string | undefined>;
  private readonly cwd: string;
  private readonly openDatabase: (dbPath: string) => LuxDatabase;
  private readonly fixedByEnvironment: boolean;
  private active: WorkspaceHandle | null = null;
  private unavailable: WorkspaceUnavailableError | null;
  private listRoots: ListRoots | null = null;
  private refreshGeneration = 0;
  private pendingRefresh: Promise<void> | null = null;
  private disposed = false;

  constructor(options: WorkspaceRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.openDatabase = options.openDatabase ?? ((dbPath) => new LuxDatabase(dbPath));
    this.fixedByEnvironment = Boolean(this.env.LUX_CORPUS_PATH || this.env.LUX_DB_PATH);
    this.unavailable = this.fixedByEnvironment
      ? null
      : new WorkspaceUnavailableError(
          'initializing',
          'The MCP workspace is still initializing. Retry after client initialization completes.'
        );

    if (this.fixedByEnvironment) {
      this.setRuntime(resolveRuntimePaths({ env: this.env, cwd: this.cwd }));
    }
  }

  /** Configure workspace discovery after MCP initialization reveals the client capabilities. */
  configureClient(listRoots: ListRoots | null): Promise<void> {
    this.assertNotDisposed();
    if (this.fixedByEnvironment) return Promise.resolve();
    if (this.listRoots) return this.pendingRefresh ?? Promise.resolve();

    this.listRoots = listRoots;
    if (!listRoots) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'roots-empty',
          'The MCP client does not provide an active workspace root. Set LUX_CORPUS_PATH explicitly or use a roots-capable client.'
        )
      );
      return Promise.resolve();
    }
    return this.refreshRoots();
  }

  /** Re-read roots after notifications/roots/list_changed. */
  refreshRoots(): Promise<void> {
    this.assertNotDisposed();
    if (this.fixedByEnvironment || !this.listRoots) return Promise.resolve();

    const generation = ++this.refreshGeneration;
    const refresh = this.listRoots()
      .then(({ roots }) => {
        if (generation !== this.refreshGeneration || this.disposed) return;
        this.applyRoots(roots);
      })
      .catch((error: unknown) => {
        if (generation !== this.refreshGeneration || this.disposed) return;
        this.setUnavailable(
          new WorkspaceUnavailableError(
            'roots-list-failed',
            `The MCP client failed to provide its active workspace root: ${String(error)}`
          )
        );
      })
      .finally(() => {
        if (this.pendingRefresh === refresh) this.pendingRefresh = null;
      });
    this.pendingRefresh = refresh;
    return refresh;
  }

  async acquire(): Promise<WorkspaceLease> {
    this.assertNotDisposed();

    // A roots-changed notification may supersede a request already in flight. Wait until the newest
    // refresh settles, not merely whichever promise happened to be pending when acquire began.
    while (this.pendingRefresh) {
      const pending = this.pendingRefresh;
      await pending;
      if (this.pendingRefresh === pending) break;
    }

    if (this.unavailable) throw this.unavailable;
    const handle = this.active;
    if (!handle) {
      throw new WorkspaceUnavailableError(
        'initializing',
        'No Lux MCP workspace is active. Retry after client initialization completes.'
      );
    }

    handle.leases += 1;
    let released = false;
    return {
      runtime: handle.runtime,
      db: handle.db,
      release: () => {
        if (released) return;
        released = true;
        handle.leases -= 1;
        this.closeIfRetired(handle);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshGeneration += 1;
    this.pendingRefresh = null;
    if (this.active) {
      this.retire(this.active);
      this.active = null;
    }
  }

  private applyRoots(roots: McpRoot[]): void {
    if (roots.length === 0) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'roots-empty',
          'The MCP client did not provide an active workspace root. Select a repository and retry.'
        )
      );
      return;
    }
    if (roots.length !== 1) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'roots-ambiguous',
          `Lux requires exactly one active workspace root; the MCP client provided ${roots.length}.`,
          { roots: roots.map((root) => root.uri) }
        )
      );
      return;
    }

    let corpusPath: string;
    try {
      const url = new URL(roots[0].uri);
      if (url.protocol !== 'file:') throw new Error(`unsupported URI scheme ${url.protocol}`);
      corpusPath = fileURLToPath(url);
    } catch (error) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'root-uri-invalid',
          `Lux requires a valid file:// workspace root: ${String(error)}`,
          { root: roots[0].uri }
        )
      );
      return;
    }

    try {
      if (!statSync(corpusPath).isDirectory()) {
        throw new Error('the workspace root is not a directory');
      }
    } catch (error) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'root-not-directory',
          `Lux cannot use workspace root ${JSON.stringify(corpusPath)}: ${String(error)}`,
          { root: roots[0].uri, corpusPath }
        )
      );
      return;
    }

    this.setRuntime(resolveRuntimePaths({ corpus: corpusPath, env: this.env, cwd: this.cwd }));
  }

  private setRuntime(runtime: RuntimePathResolution): void {
    const current = this.active;
    if (
      current &&
      current.runtime.corpusPath === runtime.corpusPath &&
      current.runtime.dbPath === runtime.dbPath
    ) {
      current.runtime = runtime;
      this.unavailable = null;
      return;
    }

    let next: WorkspaceHandle;
    try {
      next = {
        runtime,
        db: this.openDatabase(runtime.dbPath),
        leases: 0,
        retired: false,
      };
    } catch (error) {
      this.setUnavailable(
        new WorkspaceUnavailableError(
          'database-open-failed',
          `Lux could not open the index for workspace ${JSON.stringify(runtime.corpusPath)}: ${String(error)}`,
          { corpusPath: runtime.corpusPath, dbPath: runtime.dbPath }
        )
      );
      return;
    }

    this.active = next;
    this.unavailable = null;
    if (current) this.retire(current);
  }

  private setUnavailable(error: WorkspaceUnavailableError): void {
    this.unavailable = error;
    if (this.active) {
      this.retire(this.active);
      this.active = null;
    }
  }

  private retire(handle: WorkspaceHandle): void {
    handle.retired = true;
    this.closeIfRetired(handle);
  }

  private closeIfRetired(handle: WorkspaceHandle): void {
    if (handle.retired && handle.leases === 0) handle.db.close();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('WorkspaceRuntime has been disposed.');
  }
}

export function workspaceUnavailablePayload(error: WorkspaceUnavailableError): {
  error: string;
  reason: WorkspaceUnavailableReason;
  message: string;
  details: Record<string, unknown>;
} {
  return {
    error: error.code,
    reason: error.reason,
    message: error.message,
    details: error.details,
  };
}
