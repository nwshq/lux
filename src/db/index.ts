import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  Client,
  Project,
  Communication,
  KnowledgeEntry,
  Event,
  ClientInsert,
  ProjectInsert,
  CommunicationInsert,
  KnowledgeEntryInsert,
  EventInsert,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class LuxDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure database directory exists
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema() {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  // Client operations
  insertClient(client: ClientInsert): number {
    const stmt = this.db.prepare(`
      INSERT INTO clients (slug, name, type, status, file_path, metadata)
      VALUES (@slug, @name, @type, @status, @file_path, @metadata)
    `);
    const result = stmt.run({
      ...client,
      metadata: client.metadata ? JSON.stringify(client.metadata) : null,
    });
    return result.lastInsertRowid as number;
  }

  getClient(slug: string): Client | undefined {
    const stmt = this.db.prepare('SELECT * FROM clients WHERE slug = ?');
    return stmt.get(slug) as Client | undefined;
  }

  getAllClients(): Client[] {
    const stmt = this.db.prepare('SELECT * FROM clients ORDER BY name');
    return stmt.all() as Client[];
  }

  updateClient(slug: string, updates: Partial<ClientInsert>) {
    const fields: string[] = [];
    const values: Record<string, unknown> = { slug };

    if (updates.name !== undefined) {
      fields.push('name = @name');
      values.name = updates.name;
    }
    if (updates.type !== undefined) {
      fields.push('type = @type');
      values.type = updates.type;
    }
    if (updates.status !== undefined) {
      fields.push('status = @status');
      values.status = updates.status;
    }
    if (updates.file_path !== undefined) {
      fields.push('file_path = @file_path');
      values.file_path = updates.file_path;
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = @metadata');
      values.metadata = JSON.stringify(updates.metadata);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = unixepoch()');
    const stmt = this.db.prepare(`
      UPDATE clients SET ${fields.join(', ')} WHERE slug = @slug
    `);
    stmt.run(values);
  }

  deleteClient(slug: string) {
    const stmt = this.db.prepare('DELETE FROM clients WHERE slug = ?');
    stmt.run(slug);
  }

  // Project operations
  insertProject(project: ProjectInsert): number {
    const stmt = this.db.prepare(`
      INSERT INTO projects (client_id, slug, name, status, file_path, metadata)
      VALUES (@client_id, @slug, @name, @status, @file_path, @metadata)
    `);
    const result = stmt.run({
      ...project,
      metadata: project.metadata ? JSON.stringify(project.metadata) : null,
    });
    return result.lastInsertRowid as number;
  }

  getProject(clientSlug: string, projectSlug: string): Project | undefined {
    const stmt = this.db.prepare(`
      SELECT p.* FROM projects p
      JOIN clients c ON p.client_id = c.id
      WHERE c.slug = ? AND p.slug = ?
    `);
    return stmt.get(clientSlug, projectSlug) as Project | undefined;
  }

  getProjectsByClient(clientId: number): Project[] {
    const stmt = this.db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY name');
    return stmt.all(clientId) as Project[];
  }

  // Communication operations
  insertCommunication(comm: CommunicationInsert): number {
    const stmt = this.db.prepare(`
      INSERT INTO communications (client_id, project_id, type, subject, date_range, participants, file_path, metadata)
      VALUES (@client_id, @project_id, @type, @subject, @date_range, @participants, @file_path, @metadata)
    `);
    const result = stmt.run({
      ...comm,
      participants: comm.participants ? JSON.stringify(comm.participants) : null,
      metadata: comm.metadata ? JSON.stringify(comm.metadata) : null,
    });
    return result.lastInsertRowid as number;
  }

  getCommunicationsByClient(clientId: number): Communication[] {
    const stmt = this.db.prepare(`
      SELECT * FROM communications WHERE client_id = ? ORDER BY date_range DESC
    `);
    return stmt.all(clientId) as Communication[];
  }

  getCommunicationsByProject(projectId: number): Communication[] {
    const stmt = this.db.prepare(`
      SELECT * FROM communications WHERE project_id = ? ORDER BY date_range DESC
    `);
    return stmt.all(projectId) as Communication[];
  }

  // Knowledge entry operations
  insertKnowledgeEntry(entry: KnowledgeEntryInsert): number {
    const stmt = this.db.prepare(`
      INSERT INTO knowledge_entries (client_id, project_id, type, title, file_path, tags, metadata)
      VALUES (@client_id, @project_id, @type, @title, @file_path, @tags, @metadata)
    `);
    const result = stmt.run({
      ...entry,
      tags: entry.tags ? JSON.stringify(entry.tags) : null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    });
    return result.lastInsertRowid as number;
  }

  getKnowledgeEntriesByType(type: string): KnowledgeEntry[] {
    const stmt = this.db.prepare('SELECT * FROM knowledge_entries WHERE type = ?');
    return stmt.all(type) as KnowledgeEntry[];
  }

  getKnowledgeEntryByPath(filePath: string): KnowledgeEntry | undefined {
    const stmt = this.db.prepare('SELECT * FROM knowledge_entries WHERE file_path = ?');
    return stmt.get(filePath) as KnowledgeEntry | undefined;
  }

  // Event operations
  insertEvent(event: EventInsert): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (source, source_id, client_id, project_id, event_type, summary, payload)
      VALUES (@source, @source_id, @client_id, @project_id, @event_type, @summary, @payload)
    `);
    const result = stmt.run({
      ...event,
      payload: event.payload ? JSON.stringify(event.payload) : null,
    });
    return result.lastInsertRowid as number;
  }

  getRecentEvents(limit = 100): Event[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(limit) as Event[];
  }

  // Utility operations
  clearAll() {
    this.db.exec('DELETE FROM events');
    this.db.exec('DELETE FROM knowledge_entries');
    this.db.exec('DELETE FROM communications');
    this.db.exec('DELETE FROM projects');
    this.db.exec('DELETE FROM clients');
  }

  getStats() {
    const clients = this.db.prepare('SELECT COUNT(*) as count FROM clients').get() as {
      count: number;
    };
    const projects = this.db.prepare('SELECT COUNT(*) as count FROM projects').get() as {
      count: number;
    };
    const communications = this.db.prepare('SELECT COUNT(*) as count FROM communications').get() as {
      count: number;
    };
    const knowledge = this.db.prepare('SELECT COUNT(*) as count FROM knowledge_entries').get() as {
      count: number;
    };
    const events = this.db.prepare('SELECT COUNT(*) as count FROM events').get() as {
      count: number;
    };

    return {
      clients: clients.count,
      projects: projects.count,
      communications: communications.count,
      knowledge_entries: knowledge.count,
      events: events.count,
    };
  }

  close() {
    this.db.close();
  }
}
