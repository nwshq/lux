import { createRequire } from 'node:module';
import type {
  Database as WasmDatabase,
  Statement as WasmStatement,
  BindValues,
} from 'node-sqlite3-wasm';

// node-sqlite3-wasm ships a CommonJS Emscripten bundle whose exports are attached at
// runtime, so `cjs-module-lexer` cannot see them and native-ESM `import { Database }`
// fails ("no export named 'Database'"). Load it via createRequire (works under native
// ESM, tsx, and vitest alike); the value is the class, typed from the type-only import.
const require = createRequire(import.meta.url);
const { Database: WasmDb } = require('node-sqlite3-wasm') as { Database: typeof WasmDatabase };

/**
 * `LuxSqlite` — a thin, synchronous, better-sqlite3-shaped adapter over
 * `node-sqlite3-wasm` (a WASM SQLite with FTS5, no native dependency).
 *
 * It replicates the exact slice of the better-sqlite3 surface Lux uses so the DB
 * consumers change minimally. See the payload
 * `payloads/2026-07-20-wasm-sqlite-migration/10-ADAPTER-SPEC.md` for the full
 * contract and the reconciliations, each verified against node-sqlite3-wasm@0.8.59.
 */

/**
 * (1) Named-param reconciliation. better-sqlite3 binds bare keys (`{name}`) against
 * `@name` in SQL; node-sqlite3-wasm requires the prefixed key (`{'@name'}`). Prefix
 * bare keys deterministically. Arrays / scalars / null pass through untouched.
 */
function adaptParams(p: unknown): BindValues | undefined {
  if (p && typeof p === 'object' && !Array.isArray(p) && !(p instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      out[/^[@:$]/.test(k) ? k : '@' + k] = v;
    }
    return out as BindValues;
  }
  return p as BindValues | undefined;
}

/**
 * (2) Variadic-bind reconciliation. better-sqlite3's statement methods are variadic
 * (`stmt.run(a, b)` binds `?1=a, ?2=b`); node-sqlite3-wasm takes a single `values`.
 * Collapse: 0 args → undefined; 1 → `adaptParams` (object→prefixed / array / scalar);
 * ≥2 → the positional array.
 */
function bindArgs(p: unknown[]): BindValues | undefined {
  if (p.length === 0) return undefined;
  if (p.length === 1) return adaptParams(p[0]);
  return p as BindValues;
}

/** better-sqlite3 `.get()` returns `undefined` for a missing row; node-sqlite3-wasm
 *  returns `null`. Normalise to `undefined` so `... as T | undefined` casts hold. */
function normalizeGet<T>(row: T | null): T | undefined {
  return row === null ? undefined : row;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** A prepared statement, reused for the life of the owning `LuxSqlite`. */
export class Stmt {
  constructor(readonly raw: WasmStatement) {}
  run(...p: unknown[]): RunResult {
    return this.raw.run(bindArgs(p));
  }
  get(...p: unknown[]): unknown {
    return normalizeGet(this.raw.get(bindArgs(p)));
  }
  all(...p: unknown[]): unknown[] {
    return this.raw.all(bindArgs(p));
  }
}

export interface LuxSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export class LuxSqlite {
  private db: WasmDatabase;
  /** node-sqlite3-wasm does NOT auto-finalize on close → track reused statements and finalize them. */
  private stmts = new Set<Stmt>();
  /** Savepoint-nesting depth → depth-unique savepoint names. (The BEGIN-vs-SAVEPOINT
   *  decision reads the engine's real `inTransaction`; depth only names savepoints.) */
  private depth = 0;

  constructor(path: string, opts: LuxSqliteOptions = {}) {
    // (7) translate option keys: better-sqlite3 `readonly` → node-sqlite3-wasm `readOnly`.
    // undefined values are falsy → engine defaults to read-write + create, matching `new Database(path)`.
    this.db = new WasmDb(path, { readOnly: opts.readonly, fileMustExist: opts.fileMustExist });
    this.db.run('PRAGMA busy_timeout = 5000'); // WAL is gone → wait on writer overlap, don't SQLITE_BUSY
  }

  /** Cached, reusable prepared statement, tracked for finalize-on-close. */
  prepare(sql: string): Stmt {
    const s = new Stmt(this.db.prepare(sql));
    this.stmts.add(s);
    return s;
  }

  /** Multi-statement DDL (migrations). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  // ── (5) One-shot, engine-auto-finalized statements — for transient SQL that must NOT
  //    enter the finalize registry (else the never-closed MCP DB leaks a handle per call). ──

  /** One-shot parametrised write/DDL. Returns `{changes, lastInsertRowid}`. */
  run(sql: string, values?: unknown): RunResult {
    return this.db.run(sql, adaptParams(values));
  }
  /** One-shot read → all rows. */
  all(sql: string, values?: unknown): unknown[] {
    return this.db.all(sql, adaptParams(values));
  }
  /** One-shot read → first row (or `undefined`). */
  get(sql: string, values?: unknown): unknown {
    return normalizeGet(this.db.get(sql, adaptParams(values)));
  }

  /** better-sqlite3-style pragma; return value is discarded by every Lux call site.
   *  A `journal_mode = WAL` request falls back to memory/delete in-engine. */
  pragma(str: string): unknown {
    return this.db.get(`PRAGMA ${str}`);
  }

  /** better-sqlite3 semantics: returns a callable with the same args; BEGIN/COMMIT with
   *  SAVEPOINT nesting and rollback-on-throw. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const outer = !this.db.inTransaction; // engine's real flag (better-sqlite3 parity)
      const sp = `lux_sp_${this.depth}`; // depth-unique savepoint name
      this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn(...args);
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        if (this.db.inTransaction) {
          // guard: a failed COMMIT/RELEASE may already have torn it down
          this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}`);
          if (!outer) this.db.exec(`RELEASE ${sp}`); // ROLLBACK TO leaves the savepoint on the stack → pop it
        }
        throw e;
      } finally {
        this.depth--;
      }
    };
  }

  close(): void {
    for (const s of this.stmts) s.raw.finalize();
    this.stmts.clear();
    this.db.close();
  }
}
