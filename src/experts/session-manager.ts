import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import type { LuxDatabase } from '../db/index.js';
import type { Expert, ExpertSession } from '../db/types.js';
import { buildCleanEnv } from '../utils/subprocess-env.js';

const execFileAsync = promisify(execFile);

export interface QueryResult {
  response: string;
  sessionId: number;
  expertSlug: string;
}

export interface SessionInfo {
  session: ExpertSession;
  expert: Expert;
}

export interface ExpertSessionManager {
  /** Retrieve or create a session for the given expert slug. */
  getSession(expertSlug: string): SessionInfo;

  /** Send a question to an expert and return the response. */
  query(expertSlug: string, question: string): Promise<QueryResult>;

  /** Terminate a session by its ID, cleaning up resources. */
  terminate(sessionId: number): void;

  /** Check whether a session is still alive (status is 'warm' or 'active'). */
  isAlive(sessionId: number): boolean;
}

export class ExpertSessionManagerImpl implements ExpertSessionManager {
  constructor(private db: LuxDatabase) {}

  getSession(expertSlug: string): SessionInfo {
    const expert = this.db.getExpert(expertSlug);
    if (!expert) {
      throw new Error(`Expert not found: ${expertSlug}`);
    }

    // Look for an existing warm session
    const existing = this.db.getActiveSessionForExpert(expert.id);
    if (existing) {
      this.db.touchExpertSession(existing.id);
      return { session: this.db.getExpertSession(existing.id)!, expert };
    }

    // Create a new warm session
    const sessionRef = `session-${expertSlug}-${Date.now()}`;
    const sessionId = this.db.insertExpertSession({
      expert_id: expert.id,
      session_ref: sessionRef,
    });

    return { session: this.db.getExpertSession(sessionId)!, expert };
  }

  async query(expertSlug: string, question: string): Promise<QueryResult> {
    const { session, expert } = this.getSession(expertSlug);

    if (expert.status !== 'active') {
      throw new Error(`Expert is not active: ${expertSlug} (status: ${expert.status})`);
    }

    if (!existsSync(expert.mount_path)) {
      throw new Error(`Expert mount path does not exist: ${expert.mount_path}`);
    }

    // Mark session as active during query
    this.db.updateExpertSessionStatus(session.id, 'active');

    try {
      const claudeArgs = ['--print', '--model', expert.model];

      if (expert.claude_md_path && existsSync(expert.claude_md_path)) {
        const systemPrompt = readFileSync(expert.claude_md_path, 'utf-8');
        claudeArgs.push('--system-prompt', systemPrompt);
      }

      claudeArgs.push(question);

      const { stdout } = await execFileAsync('claude', claudeArgs, {
        cwd: expert.mount_path,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        env: buildCleanEnv(),
      });

      // Return session to warm after successful query
      this.db.updateExpertSessionStatus(session.id, 'warm');
      this.db.touchExpertSession(session.id);

      this.db.insertEvent({
        source: 'expert-session-manager',
        event_type: 'expert_ask',
        summary: `Asked expert "${expert.name}": ${question.slice(0, 100)}`,
        payload: {
          expert_slug: expertSlug,
          session_id: session.id,
          question,
          response_length: stdout.length,
        },
      });

      return {
        response: stdout,
        sessionId: session.id,
        expertSlug,
      };
    } catch (error) {
      // Mark session as idle on failure
      this.db.updateExpertSessionStatus(session.id, 'idle');

      const message = error instanceof Error ? error.message : String(error);

      this.db.insertEvent({
        source: 'expert-session-manager',
        event_type: 'expert_ask_error',
        summary: `Expert ask failed for "${expert.name}": ${message.slice(0, 200)}`,
        payload: {
          expert_slug: expertSlug,
          session_id: session.id,
          question,
          error: message,
        },
      });

      throw new Error(`Expert query failed: ${message}`);
    }
  }

  terminate(sessionId: number): void {
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
}
