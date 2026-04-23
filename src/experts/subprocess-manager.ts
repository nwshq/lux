import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import type { LuxDatabase } from '../db/index.js';
import { join } from 'path';
import type {
  ExpertSessionManager,
  QueryOptions,
  QueryResult,
  SessionInfo,
} from './session-manager.js';
import { buildCleanEnv } from '../utils/subprocess-env.js';
import { inferBackendFromModel, resolveAiDefaults } from '../utils/ai-defaults.js';
import type { AiBackend } from '../utils/ai-defaults.js';

/** Tracks a running expert-runtime subprocess. */
interface ActiveProcess {
  process: ChildProcess;
  sessionId: number;
  expertSlug: string;
  startedAt: number;
}

/**
 * Manages backend-aware expert subprocesses with proper lifecycle control.
 *
 * Unlike ExpertSessionManagerImpl which uses execFile (fire-and-forget),
 * SubprocessSessionManager tracks spawned processes, prevents concurrent
 * queries to the same expert, supports conversation resumption via
 * session_ref, and provides graceful shutdown of all active processes.
 */
export class SubprocessSessionManager implements ExpertSessionManager {
  private activeProcesses = new Map<number, ActiveProcess>();
  private queryTimeoutMs: number;
  private maxOutputBytes: number;

  constructor(
    private db: LuxDatabase,
    options?: {
      queryTimeoutMs?: number;
      maxOutputBytes?: number;
    }
  ) {
    this.queryTimeoutMs = options?.queryTimeoutMs ?? 300_000;
    this.maxOutputBytes = options?.maxOutputBytes ?? 10 * 1024 * 1024;
  }

  getSession(expertSlug: string): SessionInfo {
    const expert = this.db.getExpert(expertSlug);
    if (!expert) {
      throw new Error(`Expert not found: ${expertSlug}`);
    }

    const existing = this.db.getActiveSessionForExpert(expert.id);
    if (existing) {
      this.db.touchExpertSession(existing.id);
      return { session: this.db.getExpertSession(existing.id)!, expert, isExisting: true };
    }

    const sessionRef = randomUUID();
    const sessionId = this.db.insertExpertSession({
      expert_id: expert.id,
      session_ref: sessionRef,
    });

    return { session: this.db.getExpertSession(sessionId)!, expert, isExisting: false };
  }

  async query(expertSlug: string, question: string, options?: QueryOptions): Promise<QueryResult> {
    const { session, expert, isExisting } = this.getSession(expertSlug);

    if (expert.status !== 'active') {
      throw new Error(`Expert is not active: ${expertSlug} (status: ${expert.status})`);
    }

    if (!existsSync(expert.mount_path)) {
      throw new Error(`Expert mount path does not exist: ${expert.mount_path}`);
    }

    if (this.hasActiveQuery(expertSlug)) {
      throw new Error(`Expert "${expertSlug}" already has an active query`);
    }

    this.db.updateExpertSessionStatus(session.id, 'active');

    try {
      const response = await this.spawnQuery(
        session.id,
        expert.mount_path,
        expert.model,
        expert.backend,
        expert.provider,
        expert.thinking,
        expert.claude_md_path,
        session.session_ref,
        isExisting ?? false,
        this.composeExpertPrompt(expert.mount_path, question),
        expertSlug,
        options?.onChunk
      );

      this.db.updateExpertSessionStatus(session.id, 'warm');
      this.db.touchExpertSession(session.id);

      this.db.insertEvent({
        source: 'subprocess-session-manager',
        event_type: 'expert_ask',
        summary: `Asked expert "${expert.name}": ${question.slice(0, 100)}`,
        payload: {
          expert_slug: expertSlug,
          session_id: session.id,
          session_ref: session.session_ref,
          question,
          response_length: response.length,
        },
      });

      return {
        response,
        sessionId: session.id,
        expertSlug,
      };
    } catch (error) {
      this.db.updateExpertSessionStatus(session.id, 'idle');

      const message = error instanceof Error ? error.message : String(error);

      this.db.insertEvent({
        source: 'subprocess-session-manager',
        event_type: 'expert_ask_error',
        summary: `Expert ask failed for "${expert.name}": ${message.slice(0, 200)}`,
        payload: {
          expert_slug: expertSlug,
          session_id: session.id,
          session_ref: session.session_ref,
          question,
          error: message,
        },
      });

      throw new Error(`Expert query failed: ${message}`);
    }
  }

  terminate(sessionId: number): void {
    this.killProcess(sessionId);

    const session = this.db.getExpertSession(sessionId);
    if (!session) {
      return;
    }

    this.db.updateExpertSessionStatus(sessionId, 'idle');
    this.db.deleteExpertSession(sessionId);
  }

  isAlive(sessionId: number): boolean {
    const session = this.db.getExpertSession(sessionId);
    if (!session) {
      return false;
    }

    return session.status === 'warm' || session.status === 'active';
  }

  /** Returns the number of currently running subprocesses. */
  get activeCount(): number {
    return this.activeProcesses.size;
  }

  /** Returns session IDs of all currently running queries. */
  getActiveSessionIds(): number[] {
    return Array.from(this.activeProcesses.keys());
  }

  /** Terminates all active subprocesses. Use during shutdown. */
  terminateAll(): void {
    for (const [sessionId] of this.activeProcesses) {
      this.killProcess(sessionId);
    }
  }

  /** Checks if an expert currently has a running query. */
  hasActiveQuery(expertSlug: string): boolean {
    for (const active of this.activeProcesses.values()) {
      if (active.expertSlug === expertSlug) {
        return true;
      }
    }
    return false;
  }

  /** Spawns an expert runtime process and collects its output. */
  private spawnQuery(
    sessionId: number,
    cwd: string,
    model: string,
    backend: string | undefined,
    provider: string | undefined,
    thinking: string | undefined,
    claudeMdPath: string | undefined,
    sessionRef: string,
    isExistingSession: boolean,
    question: string,
    expertSlug: string,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const resolvedBackend = this.resolveBackend(backend, model);
      const { command, args } = this.buildCommandArgs({
        backend: resolvedBackend,
        model,
        provider,
        thinking,
        claudeMdPath,
        sessionRef,
        isExistingSession,
        question,
      });

      if (resolvedBackend === 'pi') {
        this.ensurePiSessionDir(cwd);
      }

      const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildCleanEnv(),
      });

      const active: ActiveProcess = {
        process: child,
        sessionId,
        expertSlug,
        startedAt: Date.now(),
      };
      this.activeProcesses.set(sessionId, active);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;

      const timeout = setTimeout(() => {
        this.killProcess(sessionId);
        reject(new Error(`Query timed out after ${this.queryTimeoutMs}ms`));
      }, this.queryTimeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.maxOutputBytes) {
          stdoutChunks.push(chunk);
          if (onChunk) {
            onChunk(chunk.toString('utf-8'));
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(sessionId);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        this.activeProcesses.delete(sessionId);

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (code !== 0) {
          const detail = stderr.trim() || `Process exited with code ${code}`;
          reject(new Error(detail));
          return;
        }

        if (totalBytes > this.maxOutputBytes) {
          reject(
            new Error(
              `Output exceeded maximum size (${totalBytes} bytes > ${this.maxOutputBytes} bytes)`
            )
          );
          return;
        }

        resolve(stdout);
      });
    });
  }

  private resolveBackend(backend: string | undefined, model: string): AiBackend {
    if (backend === 'claude' || backend === 'pi') {
      return backend;
    }

    return inferBackendFromModel(model);
  }

  private buildCommandArgs(params: {
    backend: AiBackend;
    model: string;
    provider?: string;
    thinking?: string;
    claudeMdPath?: string;
    sessionRef: string;
    isExistingSession: boolean;
    question: string;
  }): { command: string; args: string[] } {
    if (params.backend === 'claude') {
      return {
        command: 'claude',
        args: this.buildClaudeArgs(
          params.model,
          params.claudeMdPath,
          params.sessionRef,
          params.isExistingSession,
          params.question
        ),
      };
    }

    return {
      command: 'pi',
      args: this.buildPiArgs(
        params.model,
        params.provider,
        params.thinking,
        params.claudeMdPath,
        params.sessionRef,
        params.question
      ),
    };
  }

  private buildClaudeArgs(
    model: string,
    claudeMdPath: string | undefined,
    sessionRef: string,
    isExistingSession: boolean,
    question: string
  ): string[] {
    const args = ['--print', '--permission-mode', 'bypassPermissions', '--model', model];
    if (isExistingSession) {
      args.push('--resume', sessionRef);
    }

    if (claudeMdPath && existsSync(claudeMdPath)) {
      const systemPrompt = readFileSync(claudeMdPath, 'utf-8');
      args.push('--system-prompt', systemPrompt);
    }

    args.push(question);
    return args;
  }

  private buildPiArgs(
    model: string,
    provider: string | undefined,
    thinking: string | undefined,
    claudeMdPath: string | undefined,
    sessionRef: string,
    question: string
  ): string[] {
    const args = [
      '--provider',
      provider ?? resolveAiDefaults().provider ?? 'openai',
      '--model',
      model,
      '--thinking',
      thinking ?? resolveAiDefaults().thinking ?? 'high',
      '--mode',
      'text',
      '--print',
    ];

    args.push('--session', this.sessionFilePath(sessionRef));

    if (claudeMdPath && existsSync(claudeMdPath)) {
      const systemPrompt = readFileSync(claudeMdPath, 'utf-8');
      args.push('--system-prompt', systemPrompt);
    }

    args.push(question);
    return args;
  }

  private composeExpertPrompt(mountPath: string, question: string): string {
    return [
      `You are operating inside the expert mount path: ${mountPath}.`,
      'Use the local files in this directory as your primary source of truth.',
      'If the answer depends on repository files, inspect them directly before answering.',
      '',
      question,
    ].join('\n');
  }

  private sessionFilePath(sessionRef: string): string {
    const safe = sessionRef.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'session';
    return join('.lux', 'expert-sessions', `${safe}.jsonl`);
  }

  private ensurePiSessionDir(cwd: string): void {
    mkdirSync(join(cwd, '.lux', 'expert-sessions'), { recursive: true });
  }

  /** Kills a tracked subprocess, escalating from SIGTERM to SIGKILL. */
  private killProcess(sessionId: number): void {
    const active = this.activeProcesses.get(sessionId);
    if (!active) {
      return;
    }

    const { process: child } = active;

    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');

      // Escalate to SIGKILL if process doesn't exit within 5s
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      }, 5_000);
    }

    this.activeProcesses.delete(sessionId);
  }
}
