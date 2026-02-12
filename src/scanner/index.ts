import { readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';
import type {
  Frontmatter,
  ScannedClient,
  ScannedProject,
  ScannedCommunication,
  ScannedKnowledge,
  ScanResult,
} from './types.js';

export class CorpusScanner {
  private corpusPath: string;

  constructor(corpusPath: string) {
    this.corpusPath = corpusPath;
  }

  async scan(): Promise<ScanResult> {
    const clients: ScannedClient[] = [];
    const projects: ScannedProject[] = [];
    const communications: ScannedCommunication[] = [];
    const knowledge: ScannedKnowledge[] = [];

    // Scan clients directory
    const clientsPath = join(this.corpusPath, 'knowledge/10_clients');
    const clientDirs = await glob('*/', { cwd: clientsPath });

    for (const clientDir of clientDirs) {
      const clientSlug = clientDir.replace('/', '');
      const clientPath = join(clientsPath, clientDir);
      const readmePath = join(clientPath, 'README.md');

      // Check if client README exists
      try {
        statSync(readmePath);
      } catch {
        continue; // Skip if no README
      }

      const clientData = this.parseMarkdownFile(readmePath);
      clients.push({
        slug: clientSlug,
        name: clientData.frontmatter?.name
          ? String(clientData.frontmatter.name)
          : this.slugToTitle(clientSlug),
        type: clientData.frontmatter?.type ? String(clientData.frontmatter.type) : undefined,
        status: clientData.frontmatter?.status
          ? String(clientData.frontmatter.status)
          : undefined,
        filePath: readmePath,
        frontmatter: clientData.frontmatter,
      });

      // Scan projects within client
      const projectDirs = await glob('*/', { cwd: clientPath });
      for (const projectDir of projectDirs) {
        const projectSlug = projectDir.replace('/', '');

        // Skip special directories
        if (['communications', '_meta', 'archive'].includes(projectSlug)) {
          continue;
        }

        const projectPath = join(clientPath, projectDir);
        const projectReadmePath = join(projectPath, 'README.md');

        try {
          statSync(projectReadmePath);
        } catch {
          continue; // Skip if no README
        }

        const projectData = this.parseMarkdownFile(projectReadmePath);
        projects.push({
          clientSlug,
          slug: projectSlug,
          name: projectData.frontmatter?.name
            ? String(projectData.frontmatter.name)
            : this.slugToTitle(projectSlug),
          status: projectData.frontmatter?.status
            ? String(projectData.frontmatter.status)
            : undefined,
          filePath: projectReadmePath,
          frontmatter: projectData.frontmatter,
        });
      }

      // Scan communications
      const commsPath = join(clientPath, 'communications');
      try {
        statSync(commsPath);
        const commFiles = await glob('*.md', { cwd: commsPath });

        for (const commFile of commFiles) {
          const commPath = join(commsPath, commFile);
          const commData = this.parseMarkdownFile(commPath);

          // Try to extract date from filename (YYYY-MM-DD_*.md)
          const dateMatch = commFile.match(/^(\d{4}-\d{2}-\d{2})/);
          const dateRange = dateMatch
            ? dateMatch[1]
            : commData.frontmatter?.date
              ? String(commData.frontmatter.date)
              : undefined;

          const subject =
            commData.frontmatter?.subject ?? commData.frontmatter?.title
              ? String(commData.frontmatter.subject ?? commData.frontmatter.title)
              : this.extractTitleFromFilename(commFile);

          communications.push({
            clientSlug,
            type: commData.frontmatter?.type
              ? String(commData.frontmatter.type)
              : this.inferCommType(commFile),
            subject,
            dateRange,
            participants: commData.frontmatter?.participants as string[] | undefined,
            filePath: commPath,
            frontmatter: commData.frontmatter,
          });
        }
      } catch {
        // No communications directory
      }
    }

    // Scan other knowledge directories
    const knowledgeDirs = [
      'knowledge/20_methodology',
      'knowledge/30_specs',
      'knowledge/40_architecture',
      'explorations',
      'implementation-payloads',
    ];

    for (const dir of knowledgeDirs) {
      const dirPath = join(this.corpusPath, dir);
      try {
        statSync(dirPath);
        const mdFiles = await glob('**/*.md', { cwd: dirPath });

        for (const mdFile of mdFiles) {
          const filePath = join(dirPath, mdFile);
          const fileData = this.parseMarkdownFile(filePath);

          knowledge.push({
            type: this.inferKnowledgeType(dir, fileData.frontmatter),
            title: fileData.frontmatter?.title
              ? String(fileData.frontmatter.title)
              : this.extractTitleFromFilename(mdFile),
            filePath,
            tags: fileData.frontmatter?.tags as string[] | undefined,
            frontmatter: fileData.frontmatter,
          });
        }
      } catch {
        // Directory doesn't exist
      }
    }

    return { clients, projects, communications, knowledge };
  }

  private parseMarkdownFile(filePath: string): { frontmatter?: Frontmatter; content: string } {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = matter(content);
      return {
        frontmatter: parsed.data as Frontmatter,
        content: parsed.content,
      };
    } catch (error) {
      return { content: '' };
    }
  }

  private slugToTitle(slug: string): string {
    return slug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private extractTitleFromFilename(filename: string): string {
    const base = basename(filename, '.md');
    // Remove date prefix if present
    const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}_/, '');
    return this.slugToTitle(withoutDate);
  }

  private inferCommType(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.includes('email')) return 'email';
    if (lower.includes('slack')) return 'slack';
    if (lower.includes('meeting')) return 'meeting';
    if (lower.includes('call')) return 'call';
    return 'other';
  }

  private inferKnowledgeType(dirPath: string, frontmatter?: Frontmatter): string {
    if (frontmatter?.type) return String(frontmatter.type);

    if (dirPath.includes('methodology')) return 'methodology';
    if (dirPath.includes('specs')) return 'spec';
    if (dirPath.includes('architecture')) return 'architecture';
    if (dirPath.includes('explorations')) return 'exploration';
    if (dirPath.includes('implementation-payloads')) return 'implementation-payload';

    return 'general';
  }
}
