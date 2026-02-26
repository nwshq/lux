import type { Expert, ExpertSession } from '../db/types.js';

export interface QueryResult {
  response: string;
  sessionId: number;
  expertSlug: string;
}

export interface QueryOptions {
  /** Called with each chunk of output as it arrives from the subprocess. */
  onChunk?: (chunk: string) => void;
}

export interface SessionInfo {
  session: ExpertSession;
  expert: Expert;
  isExisting?: boolean;
}

export interface ExpertSessionManager {
  /** Retrieve or create a session for the given expert slug. */
  getSession(expertSlug: string): SessionInfo;

  /** Send a question to an expert and return the response. */
  query(expertSlug: string, question: string, options?: QueryOptions): Promise<QueryResult>;

  /** Terminate a session by its ID, cleaning up resources. */
  terminate(sessionId: number): void;

  /** Check whether a session is still alive (status is 'warm' or 'active'). */
  isAlive(sessionId: number): boolean;
}
