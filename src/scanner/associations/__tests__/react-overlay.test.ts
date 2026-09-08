import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../../db/index.js';
import { reactComponentId, reactHookId } from '../../identity/program-identity.js';
import type { ScanResult } from '../../types.js';
import { rebuildStructuralOverlay } from '../overlay-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Phase 15 React overlay integration', () => {
  it('materializes component and hook nodes before storing exact relationships', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lux-react-overlay-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{"name":"react-fixture"}');
    const files = {
      'src/Child.tsx': `export function Child(){ return <div/> }`,
      'src/useCatalog.ts': `export function useCatalog(){ return 1 }`,
      'src/App.tsx': `import { Child } from './Child'; import { useCatalog } from './useCatalog';
        export function App(){ useCatalog(); return <Child/> }`,
    };
    const knowledge: ScanResult['knowledge'] = [];
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, content);
      knowledge.push({
        type: 'source-code',
        title: path,
        filePath: absolute,
        frontmatter: { language: 'typescript', extension: '.tsx' },
        content,
      });
    }
    const db = new LuxDatabase(join(root, 'lux.db'));
    await rebuildStructuralOverlay(db, root, { knowledge }, new Map(), {
      astEnabled: true,
      detectors: [],
      operationalExtractors: [],
    });
    const app = reactComponentId('src/App.tsx', 'App');
    const child = reactComponentId('src/Child.tsx', 'Child');
    const hook = reactHookId('src/useCatalog.ts', 'useCatalog');
    expect(db.getStructuralNode(app)).not.toBeNull();
    expect(db.getStructuralNode(child)).not.toBeNull();
    expect(db.getStructuralNode(hook)).not.toBeNull();
    expect(db.getOutgoingStructuralEdges(app)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge_type: 'renders_component', target_node_id: child }),
        expect.objectContaining({ edge_type: 'uses_hook', target_node_id: hook }),
      ])
    );
    db.close();
  });
});
