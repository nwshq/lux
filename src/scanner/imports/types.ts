/** A single import statement parsed from a source file. */
export interface ImportStatement {
  /** The raw import path/namespace. */
  rawImport: string;
  /** Resolution mode used by the canonical project resolver. */
  mode?: 'import' | 'require' | 'reexport' | 'dynamic-import';
  /** The resolved module name (via boundary detection), or null. */
  resolvedModule: string | null;
  /** The imported symbol name(s). */
  symbols: string[];
}

/** Configuration for module boundary detection. */
export interface ModuleBoundaryConfig {
  /** Patterns like "src/Module/{name}", "packages/{name}". */
  patterns?: string[];
}

/** Result of parsing all imports from a single file and resolving modules. */
export interface ParsedModuleImports {
  /** The file that was parsed. */
  filePath: string;
  /** The module this file belongs to. */
  sourceModule: string | null;
  /** Modules this file imports from (with counts). */
  targetModules: Map<string, { count: number; sampleFiles: string[] }>;
}
