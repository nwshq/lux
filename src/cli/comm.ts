import { Command } from 'commander';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { LuxDatabase } from '../db/index.js';
import { createMarkdownWithFrontmatter } from '../utils/frontmatter.js';

export function addCommCommands(program: Command) {
  const commCmd = program.command('comm').description('Manage communications');

  commCmd
    .command('log')
    .description('Log a new communication')
    .requiredOption('--client <slug>', 'Client slug')
    .option('--project <slug>', 'Project slug (optional)')
    .requiredOption('--type <type>', 'Communication type (email, slack, meeting, call, etc.)')
    .requiredOption('--subject <subject>', 'Communication subject')
    .option('--date <date>', 'Date (YYYY-MM-DD)', new Date().toISOString().split('T')[0])
    .option('--participants <participants>', 'Comma-separated participants')
    .option('--content <content>', 'Communication content')
    .option('--file <path>', 'Path to file containing communication content')
    .action(
      (options: {
        client: string;
        project?: string;
        type: string;
        subject: string;
        date: string;
        participants?: string;
        content?: string;
        file?: string;
      }) => {
        const opts = program.opts();
        const db = new LuxDatabase(opts.db as string);

        // Validate content options
        if (options.content && options.file) {
          console.error('Cannot specify both --content and --file');
          db.close();
          process.exit(1);
        }

        // Read content from file if specified
        let contentText = options.content ?? '';
        if (options.file) {
          if (!existsSync(options.file)) {
            console.error(`File not found: ${options.file}`);
            db.close();
            process.exit(1);
          }
          try {
            contentText = readFileSync(options.file, 'utf-8');
          } catch (error) {
            console.error(`Failed to read file: ${options.file}`, error);
            db.close();
            process.exit(1);
          }
        }

        // Verify client exists
        const client = db.getClient(options.client);
        if (!client) {
          console.error(`Client not found: ${options.client}`);
          db.close();
          process.exit(1);
        }

        // Verify project if specified
        let project;
        if (options.project) {
          project = db.getProject(options.client, options.project);
          if (!project) {
            console.error(`Project not found: ${options.client}/${options.project}`);
            db.close();
            process.exit(1);
          }
        }

        // Generate filename: YYYY-MM-DD_type_subject.md
        const subjectSlug = options.subject
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const filename = `${options.date}_${options.type}_${subjectSlug}.md`;

        // Determine file path
        const commsDir = join(
          dirname(client.file_path),
          options.project ? options.project : '',
          'communications'
        );
        mkdirSync(commsDir, { recursive: true });
        const filePath = join(commsDir, filename);

        // Generate file content with frontmatter
        const participantsList = options.participants
          ? options.participants.split(',').map((p) => p.trim())
          : [];

        const fileContent = createMarkdownWithFrontmatter(
          {
            type: options.type,
            subject: options.subject,
            date: options.date,
            participants: participantsList.length > 0 ? participantsList : undefined,
          },
          contentText
        );

        // Write file
        writeFileSync(filePath, fileContent, 'utf-8');

        // Add to database
        db.insertCommunication({
          client_id: client.id,
          project_id: project?.id,
          type: options.type,
          subject: options.subject,
          date_range: options.date,
          participants: participantsList,
          file_path: filePath,
          metadata: {},
          content: contentText,
        });

        // Log event
        db.insertEvent({
          source: 'cli',
          event_type: 'comm_logged',
          client_id: client.id,
          project_id: project?.id,
          summary: `Logged ${options.type}: ${options.subject}`,
          payload: { file_path: filePath },
        });

        console.log(`✓ Communication logged: ${filePath}`);
        db.close();
      }
    );

  commCmd
    .command('list')
    .description('List communications')
    .requiredOption('--client <slug>', 'Client slug')
    .option('--project <slug>', 'Project slug (optional)')
    .option('--type <type>', 'Filter by type')
    .option('--since <date>', 'Filter by start date (YYYY-MM-DD)')
    .option('--until <date>', 'Filter by end date (YYYY-MM-DD)')
    .option('--limit <n>', 'Limit results', '20')
    .action(
      (options: {
        client: string;
        project?: string;
        type?: string;
        since?: string;
        until?: string;
        limit: string;
      }) => {
        const opts = program.opts();
        const db = new LuxDatabase(opts.db as string);

        const client = db.getClient(options.client);
        if (!client) {
          console.error(`Client not found: ${options.client}`);
          db.close();
          process.exit(1);
        }

        let comms = options.project
          ? (() => {
              const project = db.getProject(options.client, options.project);
              return project ? db.getCommunicationsByProject(project.id) : [];
            })()
          : db.getCommunicationsByClient(client.id);

        if (options.type) {
          comms = comms.filter((c) => c.type === options.type);
        }

        // Filter by date range
        if (options.since || options.until) {
          comms = comms.filter((c) => {
            if (!c.date_range) return false;
            const commDate = c.date_range; // ISO date format YYYY-MM-DD

            if (options.since && commDate < options.since) return false;
            if (options.until && commDate > options.until) return false;

            return true;
          });
        }

        const limit = parseInt(options.limit, 10);
        comms = comms.slice(0, limit);

        if (comms.length === 0) {
          console.log('No communications found.');
          db.close();
          return;
        }

        console.log(`\nCommunications (${comms.length}):\n`);
        for (const comm of comms) {
          console.log(`[${comm.type}] ${comm.subject ?? 'Untitled'}`);
          if (comm.date_range) console.log(`  Date: ${comm.date_range}`);
          if (comm.participants) {
            const participants = JSON.parse(comm.participants) as string[];
            if (participants.length > 0) {
              console.log(`  Participants: ${participants.join(', ')}`);
            }
          }
          console.log(`  Path: ${comm.file_path}`);
          console.log();
        }

        db.close();
      }
    );
}
