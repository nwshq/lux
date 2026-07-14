// TypeScript and JavaScript LSP Enricher using typescript-language-server.
//
// Provides document symbol extraction, reference lookups, and definition queries
// for TypeScript (.ts, .tsx) and JavaScript (.js, .jsx) files. Enrichment results
// are structured for storage in metadata.lsp fields on indexed entities.

import { readFileSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import type { DocumentSymbol, Location } from 'vscode-languageserver-protocol';
import { LspClient } from './client.js';
import type {
  LspEnricher,
  LspEnricherConfig,
  EnrichmentResult,
  EnrichedDefinition,
} from './index.js';
import { toEnrichedSymbol } from './index.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Optional overrides for TypeScriptLspEnricher behavior. */
export interface TypeScriptLspEnricherOptions {
  /** Override the typescript-language-server command (default: "typescript-language-server"). */
  serverCommand?: string;
  /** Override server arguments (default: ["--stdio"]). */
  serverArgs?: string[];
  /** Maximum concurrent LSP requests (default: 4). */
  maxConcurrency?: number;
  /** Per-request timeout in ms (default: 15000). */
  requestTimeoutMs?: number;
  /** Initialization timeout in ms (default: 60000). */
  initTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// TypeScriptLspEnricher
// ---------------------------------------------------------------------------

/**
 * LSP enricher for TypeScript and JavaScript files using typescript-language-server.
 *
 * Performs three categories of enrichment:
 * 1. **Document symbols** — full symbol tree via textDocument/documentSymbol
 * 2. **Definitions** — definition locations for key symbols via textDocument/definition
 * 3. **Diagnostics** — type errors and warnings from the language server
 *
 * The enrichment results are structured for storage in `metadata.lsp` fields
 * on indexed database entities.
 */
export class TypeScriptLspEnricher implements LspEnricher {
  readonly languageId = 'typescript';
  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];
  readonly config: LspEnricherConfig;

  private client: LspClient | null = null;
  private _isReady = false;

  constructor(options?: TypeScriptLspEnricherOptions) {
    this.config = {
      serverCommand: options?.serverCommand ?? 'typescript-language-server',
      serverArgs: options?.serverArgs ?? ['--stdio'],
      maxConcurrency: options?.maxConcurrency ?? 4,
      requestTimeoutMs: options?.requestTimeoutMs ?? 15_000,
      initTimeoutMs: options?.initTimeoutMs ?? 60_000,
    };
  }

  get isReady(): boolean {
    return this._isReady;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(workspaceRoot: string): Promise<void> {
    if (this._isReady) return;

    const rootUri = pathToFileURL(workspaceRoot).toString();

    this.client = new LspClient({
      serverCommand: this.config.serverCommand,
      serverArgs: this.config.serverArgs,
      cwd: workspaceRoot,
      maxConcurrency: this.config.maxConcurrency,
      requestTimeoutMs: this.config.requestTimeoutMs,
      initTimeoutMs: this.config.initTimeoutMs,
    });

    await this.client.initialize({
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          definition: {},
          references: {},
          publishDiagnostics: {
            relatedInformation: true,
          },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
    });

    this._isReady = true;
  }

  async shutdown(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.shutdown();
    } finally {
      this.client = null;
      this._isReady = false;
    }
  }

  // -------------------------------------------------------------------------
  // Enrichment
  // -------------------------------------------------------------------------

  async enrich(filePath: string): Promise<EnrichmentResult | null> {
    if (!this._isReady || !this.client) {
      throw new Error('TypeScriptLspEnricher is not initialized. Call initialize() first.');
    }

    const uri = pathToFileURL(filePath).toString();
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const languageId = ext === '.js' || ext === '.jsx' ? 'javascript' : 'typescript';

    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    this.client.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: fileContent,
      },
    });

    try {
      // 1. Get document symbols
      const rawSymbols = await this.getDocumentSymbols(uri);
      const symbols = rawSymbols.map(toEnrichedSymbol);

      // 2. Get definitions for top-level symbols
      const definitions = await this.getDefinitions(uri, rawSymbols);

      // 3. Get diagnostics (published asynchronously; we collect what's available)
      const diagnostics = await this.getDiagnostics(uri);

      return {
        filePath,
        languageId: this.languageId,
        symbols,
        diagnostics,
        definitions,
        enrichedAt: Math.floor(Date.now() / 1000),
      };
    } finally {
      this.client.notify('textDocument/didClose', {
        textDocument: { uri },
      });
    }
  }

  async resolveDefinition(
    filePath: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null> {
    if (!this._isReady || !this.client) return null;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
    const uri = pathToFileURL(filePath).toString();
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const languageId = ext === '.js' || ext === '.jsx' ? 'javascript' : 'typescript';
    this.client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: content },
    });
    try {
      const result = await this.client.request<Location | Location[] | null>(
        'textDocument/definition',
        { textDocument: { uri }, position: { line, character } }
      );
      const loc = Array.isArray(result) ? result[0] : result;
      if (!loc) return null;
      return { filePath: fileURLToPath(loc.uri), line: loc.range.start.line };
    } catch {
      return null;
    } finally {
      this.client.notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  async enrichBatch(filePaths: string[]): Promise<EnrichmentResult[]> {
    const results: EnrichmentResult[] = [];

    for (const filePath of filePaths) {
      const result = await this.enrich(filePath);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // LSP queries
  // -------------------------------------------------------------------------

  private async getDocumentSymbols(uri: string): Promise<DocumentSymbol[]> {
    try {
      const result = await this.client!.request<DocumentSymbol[] | null>(
        'textDocument/documentSymbol',
        { textDocument: { uri } }
      );
      return result ?? [];
    } catch {
      return [];
    }
  }

  private async getDefinitions(
    uri: string,
    symbols: DocumentSymbol[]
  ): Promise<EnrichedDefinition[]> {
    const definitions: EnrichedDefinition[] = [];

    // Only query definitions for top-level symbols to limit request volume
    const topLevel = symbols.slice(0, 20);

    for (const symbol of topLevel) {
      try {
        const position = symbol.selectionRange.start;
        const result = await this.client!.request<Location | Location[] | null>(
          'textDocument/definition',
          {
            textDocument: { uri },
            position: { line: position.line, character: position.character },
          }
        );

        if (!result) continue;

        const locations = Array.isArray(result) ? result : [result];
        for (const loc of locations.slice(0, 5)) {
          definitions.push({
            symbolName: symbol.name,
            targetUri: loc.uri,
            targetStartLine: loc.range.start.line,
          });
        }
      } catch {
        // Skip symbols that fail definition lookup
      }
    }

    return definitions;
  }

  private getDiagnostics(uri: string) {
    // typescript-language-server pushes diagnostics asynchronously via
    // textDocument/publishDiagnostics notifications. For now we return an
    // empty array — callers that need diagnostics can listen to the
    // notification stream directly.
    // Future enhancement: buffer published diagnostics during enrichment.
    void uri;
    return Promise.resolve([]);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Build stable node IDs for TypeScript/JavaScript symbols.
   * Format: `symbol:ts:<relativeFilePath>#<symbolName>`
   */
  static buildSymbolNodeId(relativeFilePath: string, symbolName: string): string {
    return `symbol:ts:${relativeFilePath}#${symbolName}`;
  }

  /**
   * Build a stable file node ID for a relative path.
   */
  static buildFileNodeId(relativeFilePath: string): string {
    return `file:${relativeFilePath}`;
  }
}
