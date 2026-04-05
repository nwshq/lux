import { describe, it, expect } from 'vitest';
import { parseTsImports } from '../typescript.js';

describe('TypeScript Import Parser', () => {
  it('should parse ESM named imports', () => {
    const content = `import { UserService, UserRepository } from './users/index.js';`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./users/index.js');
    expect(imports[0].symbols).toContain('UserService');
    expect(imports[0].symbols).toContain('UserRepository');
  });

  it('should parse ESM default import', () => {
    const content = `import UserService from './users/UserService.js';`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./users/UserService.js');
    expect(imports[0].symbols).toContain('UserService');
  });

  it('should parse side-effect imports', () => {
    const content = `import './polyfills.js';`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./polyfills.js');
  });

  it('should parse type-only imports', () => {
    const content = `import type { UserType } from '../types.js';`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('../types.js');
  });

  it('should parse re-exports', () => {
    const content = `export { foo, bar } from './utils.js';
export * from './helpers.js';`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(2);
    expect(imports[0].rawImport).toBe('./utils.js');
    expect(imports[1].rawImport).toBe('./helpers.js');
  });

  it('should parse require calls', () => {
    const content = `const fs = require('./local-fs.js');
const utils = require('../utils/helpers.js');`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(2);
    expect(imports[0].rawImport).toBe('./local-fs.js');
    expect(imports[1].rawImport).toBe('../utils/helpers.js');
  });

  it('should parse dynamic imports', () => {
    const content = `const mod = await import('./dynamic-module.js');`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./dynamic-module.js');
  });

  it('should ignore external packages (no . or / prefix)', () => {
    const content = `import express from 'express';
import { join } from 'path';
import { foo } from './local.js';`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./local.js');
  });

  it('should ignore external scoped packages', () => {
    const content = `import { sdk } from '@anthropic-ai/sdk';
import { local } from './local.js';`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./local.js');
  });

  it('should ignore commented imports', () => {
    const content = `// import { disabled } from './disabled.js';
import { active } from './active.js';
/* import { blocked } from './blocked.js'; */`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./active.js');
  });

  it('should handle double-quoted imports', () => {
    const content = `import { foo } from "./bar.js";`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./bar.js');
  });

  it('should return empty for content with no imports', () => {
    const content = `const x = 42;
export function hello() { return 'world'; }`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(0);
  });

  it('should handle require of external packages', () => {
    const content = `const express = require('express');
const local = require('./local.js');`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('./local.js');
  });

  it('should set resolvedModule to null', () => {
    const content = `import { foo } from './bar.js';`;
    const imports = parseTsImports(content);
    expect(imports[0].resolvedModule).toBeNull();
  });

  it('should parse import with alias', () => {
    const content = `import { foo as bar } from './module.js';`;
    const imports = parseTsImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].symbols).toContain('foo');
  });
});
