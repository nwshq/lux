// Scanner-specific types and frontmatter structures

export interface Frontmatter {
  name?: string;
  title?: string;
  subject?: string;
  type?: string;
  status?: string;
  date?: string;
  participants?: string[];
  tags?: string[];
  [key: string]: unknown;
}

export interface ScannedClient {
  slug: string;
  name: string;
  type?: string;
  status?: string;
  filePath: string;
  frontmatter?: Frontmatter;
  content?: string;
}

export interface ScannedProject {
  clientSlug: string;
  slug: string;
  name: string;
  status?: string;
  filePath: string;
  frontmatter?: Frontmatter;
  content?: string;
  hasExplorations?: boolean;
  hasPayloads?: boolean;
}

export interface ScannedCommunication {
  clientSlug: string;
  projectSlug?: string;
  type: string;
  subject?: string;
  dateRange?: string;
  participants?: string[];
  filePath: string;
  frontmatter?: Frontmatter;
  content?: string;
}

export interface ScannedKnowledge {
  clientSlug?: string;
  projectSlug?: string;
  type: string;
  title: string;
  filePath: string;
  tags?: string[];
  frontmatter?: Frontmatter;
  content?: string;
}

export interface ScanResult {
  clients: ScannedClient[];
  projects: ScannedProject[];
  communications: ScannedCommunication[];
  knowledge: ScannedKnowledge[];
}
