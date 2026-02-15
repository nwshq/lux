# CorpusScanner API

## Overview

The `CorpusScanner` class scans a CORPUS directory and returns structured entities (clients, projects, communications, knowledge entries).

## Usage

### Pattern 1: Constructor-based (backward compatible)

```typescript
import { CorpusScanner } from './scanner/index.js';

const scanner = new CorpusScanner('/path/to/CORPUS');
const result = await scanner.scan();
```

### Pattern 2: Scan parameter (flexible)

```typescript
import { CorpusScanner } from './scanner/index.js';

const scanner = new CorpusScanner();
const result = await scanner.scan('/path/to/CORPUS');
```

### Pattern 3: Mixed (override constructor path)

```typescript
import { CorpusScanner } from './scanner/index.js';

const scanner = new CorpusScanner('/default/path');
const result = await scanner.scan('/override/path');
```

## Return Value

```typescript
interface ScanResult {
  clients: ScannedClient[];
  projects: ScannedProject[];
  communications: ScannedCommunication[];
  knowledge: ScannedKnowledge[];
}
```

### ScannedClient

```typescript
interface ScannedClient {
  slug: string;
  name: string;
  type?: string;
  status?: string;
  filePath: string;
  frontmatter?: Frontmatter;
}
```

### ScannedProject

```typescript
interface ScannedProject {
  clientSlug: string;
  slug: string;
  name: string;
  status?: string;
  filePath: string;
  frontmatter?: Frontmatter;
}
```

### ScannedCommunication

```typescript
interface ScannedCommunication {
  clientSlug: string;
  projectSlug?: string;
  type: string;
  subject?: string;
  dateRange?: string;
  participants?: string[];
  filePath: string;
  frontmatter?: Frontmatter;
}
```

### ScannedKnowledge

```typescript
interface ScannedKnowledge {
  clientSlug?: string;
  projectSlug?: string;
  type: string;
  title: string;
  filePath: string;
  tags?: string[];
  frontmatter?: Frontmatter;
}
```

## CORPUS Structure

The scanner expects the following directory structure:

```
CORPUS/
├── knowledge/
│   ├── 10_clients/
│   │   └── {client-slug}/
│   │       ├── README.md or AGENTS.md or CLAUDE.md
│   │       ├── {project-slug}/
│   │       │   └── README.md or AGENTS.md or CLAUDE.md
│   │       └── communications/
│   │           └── *.md
│   ├── 20_methodology/
│   ├── 30_specs/
│   └── 40_architecture/
├── explorations/
└── implementation-payloads/
```

## Frontmatter Parsing

The scanner extracts YAML frontmatter from markdown files:

```markdown
---
name: Client Name
type: consulting
status: active
tags: [ai, backend]
---

Content...
```

## Indexing to Database

### `index()` Method

After scanning, use the `index()` method to write entities to SQLite:

```typescript
import { CorpusScanner } from './scanner/index.js';
import { LuxDatabase } from './db/index.js';

const scanner = new CorpusScanner('/path/to/CORPUS');
const db = new LuxDatabase('/path/to/lux.db');

// Scan and index
const result = await scanner.scan();
const indexed = await scanner.index(db, result);

console.log(`Indexed: ${indexed.clients} clients, ${indexed.projects} projects`);
```

### Index Return Value

```typescript
{
  clients: number;      // Number of clients indexed
  projects: number;     // Number of projects indexed
  communications: number; // Number of communications indexed
  knowledge: number;    // Number of knowledge entries indexed
}
```

### Index Behavior

- **Relationship handling**: Automatically handles entity relationships (clients → projects → communications)
- **Metadata storage**: Frontmatter is serialized to JSON and stored in the `metadata` column
- **ID mapping**: Internal mapping ensures correct foreign key relationships
- **Error handling**: Throws descriptive errors if a parent entity (client/project) is missing

### Complete Example

```typescript
import { CorpusScanner } from './scanner/index.js';
import { LuxDatabase } from './db/index.js';

async function rebuildIndex() {
  const db = new LuxDatabase('~/.lux/lux.db');
  const scanner = new CorpusScanner('~/CORPUS');

  // Clear existing data
  db.clearAll();

  // Scan CORPUS
  const result = await scanner.scan();
  console.log(`Scanned: ${result.clients.length} clients, ${result.projects.length} projects`);

  // Index into database
  const indexed = await scanner.index(db, result);
  console.log(`Indexed: ${indexed.clients} clients, ${indexed.projects} projects`);

  // Log the event
  db.insertEvent({
    source: 'manual',
    event_type: 'index_rebuild',
    summary: `Indexed ${indexed.clients} clients, ${indexed.projects} projects`,
  });

  db.close();
}
```

## Error Handling

- If no corpus path is provided (constructor or scan parameter), throws an error
- Missing directories or files are silently skipped
- Failed frontmatter parsing falls back to extracting metadata from filenames
- `index()` throws errors if parent entities (clients for projects, etc.) are missing
