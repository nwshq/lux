// Tree-sitter AST structural extraction (WASM) for TypeScript, TSX, and PHP.
//
// Produces definition nodes (function/method/class) and candidate edges
// (imports, calls, constructions) enumerated purely from syntax. Cross-file
// call/reference targets are left unresolved (`toRaw`) for the LSP-resolve tier
// (arm D). This is the deterministic enumeration substrate described in the
// approved exploration `2026-07-12-extraction-contract-ast-and-lsp`.
//
// web-tree-sitter is pinned to 0.22.x: the prebuilt tree-sitter-wasms grammars
// are compiled with tree-sitter-cli 0.20.x, whose Emscripten dylink ABI the
// 0.25+ runtime rewrite can no longer load.

import { createRequire } from 'node:module';
import { dirname, join, extname } from 'node:path';
import Parser from 'web-tree-sitter';

type TsNode = Parser.SyntaxNode;

const require = createRequire(import.meta.url);

/** Directory holding the prebuilt grammar `.wasm` files (tree-sitter-wasms/out). */
const WASM_DIR = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export interface AstRange {
  /** 1-based line. */
  startLine: number;
  /** 0-based tree-sitter column. */
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte: number;
  endByte: number;
}

export interface AstNode {
  type: 'function' | 'method' | 'class';
  name: string;
  /** Path relative to the scanned root. */
  file: string;
  range: AstRange;
  /** Enclosing type name for methods (the class/trait/interface they belong to). */
  container?: string;
}

export interface AstEdge {
  type: 'import' | 'call' | 'new';
  fromFile: string;
  /** Module path / namespace / callee expression, as written in source. */
  toRaw: string;
  range: AstRange;
  /** Identifier token position — the point handed to LSP `definition` in arm D. */
  nameRange?: AstRange;
  /** Set only when a call/new resolves to a definition in the SAME file. */
  toFile?: string;
  resolvedSameFile?: boolean;
  /**
   * How a call's callee is referenced (calls only):
   *   - `identifier` — a bare call `foo()`: same-file function/class or import-bound.
   *   - `this`       — `this.m()` / `$this->m()` / `self::m()` / `static::m()`: a
   *                    call on the enclosing instance, resolvable to a same-class method.
   *   - `member`     — a call on any other receiver (`obj.m()`, `$svc->m()`,
   *                    `Foo::m()`, `super.m()`): a typed receiver only LSP can settle.
   */
  callKind?: 'identifier' | 'this' | 'member';
  /** The callee's leaf name — the function/method identifier, without any receiver. */
  member?: string;
}

/** An imported name bound in a file, for cross-file resolution. */
export interface ImportBinding {
  /** Local name the import is bound to in this file. */
  local: string;
  /** Original exported name in the source module (TS), or the FQN (PHP). */
  imported: string;
  /** Module specifier for TS/JS imports; absent for PHP `use`. */
  module?: string;
}

export interface Extraction {
  nodes: AstNode[];
  edges: AstEdge[];
  /** Declared namespace (PHP), used to qualify symbol identities. */
  namespace?: string;
  /** Import bindings (local name -> source), for cross-file resolution. */
  imports?: ImportBinding[];
}

// ---------------------------------------------------------------------------
// Grammar wiring
// ---------------------------------------------------------------------------

export type AstLang = 'typescript' | 'tsx' | 'php';

const GRAMMAR_WASM: Record<AstLang, string> = {
  typescript: join(WASM_DIR, 'tree-sitter-typescript.wasm'),
  tsx: join(WASM_DIR, 'tree-sitter-tsx.wasm'),
  php: join(WASM_DIR, 'tree-sitter-php.wasm'),
};

/** Map a file path to a supported AST language, or null if unsupported. */
export function langForFile(file: string): AstLang | null {
  switch (extname(file)) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.php':
      return 'php';
    default:
      return null;
  }
}

/** Node types representing definitions we surface, per language family. */
const DEF_TYPES = {
  ts: {
    function: ['function_declaration', 'generator_function_declaration'],
    method: ['method_definition'],
    class: ['class_declaration', 'abstract_class_declaration'],
  },
  php: {
    function: ['function_definition'],
    method: ['method_declaration'],
    class: ['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration'],
  },
} as const;

// ---------------------------------------------------------------------------
// Tree-walking helpers
// ---------------------------------------------------------------------------

function toRange(node: TsNode): AstRange {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}

/** Depth-first walk over named nodes. */
function walk(node: TsNode, visit: (n: TsNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    if (child) walk(child, visit);
  }
}

function nameOf(node: TsNode): string | null {
  const named = node.childForFieldName('name');
  if (named) return named.text;
  for (const c of node.namedChildren) {
    if (c && /(identifier|name)/.test(c.type)) return c.text;
  }
  return null;
}

/**
 * The name of the TS class a method belongs to, or undefined if the method is
 * not a class member (e.g. an object-literal shorthand method — which must NOT
 * be surfaced as a top-level symbol, where it would collide with real defs).
 *
 * Handles both class declarations and class expressions (`const X = class {…}`),
 * deriving the expression's name from the variable it is assigned to so its
 * methods get a stable container segment rather than a colliding bare id.
 */
function enclosingTsClassName(node: TsNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration' || cur.type === 'abstract_class_declaration') {
      return nameOf(cur) ?? undefined;
    }
    if (cur.type === 'class') {
      // Class expression: only surfaced (and thus referenceable) when assigned
      // to a variable — that name is also what the class node is extracted as.
      // An unsurfaced class expression (object-literal value, argument, IIFE)
      // has no stable id, so its methods are skipped rather than given an
      // orphan container that references no class node.
      const decl = cur.parent;
      if (decl?.type === 'variable_declarator') {
        const nm = decl.childForFieldName('name');
        if (nm) return nm.text;
      }
      return undefined;
    }
    // An object literal between the method and any class means it is an
    // object-literal method, not a class member — do not surface it.
    if (cur.type === 'object') return undefined;
    cur = cur.parent;
  }
  return undefined;
}

/**
 * The name of the PHP class a method belongs to, or undefined if the method is
 * inside an anonymous class (`new class {…}`) — whose methods have no stable
 * FQN and would otherwise collide corpus-wide on a container-less id (the same
 * defect enclosingTsClassName guards for TS). An anonymous class between the
 * method and any named class shadows the outer class, so a nested anon-class
 * method is NOT misattributed to the enclosing real class.
 */
function enclosingPhpClassName(node: TsNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'object_creation_expression') return undefined; // `new class {…}`
    if (DEF_TYPES.php.class.includes(cur.type as never)) return nameOf(cur) ?? undefined;
    cur = cur.parent;
  }
  return undefined;
}

function lastNamespaceSegment(fqn: string): string {
  const idx = fqn.lastIndexOf('\\');
  return idx >= 0 ? fqn.slice(idx + 1) : fqn;
}

/** Extract local->imported bindings from a TS `import_statement`. */
function tsImportBindings(importStmt: TsNode, module: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const clause = importStmt.namedChildren.find((c) => c && c.type === 'import_clause');
  if (!clause) return out;
  for (const child of clause.namedChildren) {
    if (!child) continue;
    if (child.type === 'identifier') {
      out.push({ local: child.text, imported: 'default', module });
    } else if (child.type === 'named_imports') {
      for (const spec of child.namedChildren) {
        if (!spec || spec.type !== 'import_specifier') continue;
        const nameNode = spec.childForFieldName('name');
        const aliasNode = spec.childForFieldName('alias');
        const imported = nameNode?.text;
        if (imported) out.push({ local: aliasNode?.text ?? imported, imported, module });
      }
    }
    // namespace_import (`* as ns`) is intentionally skipped — member access via
    // the namespace object needs resolution beyond a direct binding.
  }
  return out;
}

/** Extract local->FQN bindings from a PHP `namespace_use_declaration`. */
function phpUseBindings(useDecl: TsNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  const clauses = useDecl.descendantsOfType(['namespace_use_clause', 'namespace_use_group_clause']);
  for (const clause of clauses) {
    const nameNode =
      clause.childForFieldName('name') ??
      clause.namedChildren.find((c) => c && /(qualified_name|name|namespace_name)/.test(c.type));
    if (!nameNode) continue;
    const fqn = nameNode.text;
    const aliasNode = clause.namedChildren.find((c) => c && c.type === 'namespace_aliasing_clause');
    const alias = aliasNode?.namedChildren.find((c) => c && /(name|identifier)/.test(c.type))?.text;
    out.push({ local: alias ?? lastNamespaceSegment(fqn), imported: fqn });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extractTs(root: TsNode, file: string): Extraction {
  const nodes: AstNode[] = [];
  const edges: AstEdge[] = [];
  const imports: ImportBinding[] = [];
  const localDefs = new Set<string>();

  walk(root, (n) => {
    if (DEF_TYPES.ts.function.includes(n.type as never)) {
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'function', name, file, range: toRange(n) });
        localDefs.add(name);
      }
    } else if (DEF_TYPES.ts.method.includes(n.type as never)) {
      // Only class members are surfaced; object-literal shorthand methods are
      // not class methods and would collide with top-level symbols by id.
      const container = enclosingTsClassName(n);
      if (container === undefined) return;
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'method', name, file, range: toRange(n), container });
        localDefs.add(name);
      }
    } else if (DEF_TYPES.ts.class.includes(n.type as never)) {
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'class', name, file, range: toRange(n) });
        localDefs.add(name);
      }
    } else if (n.type === 'variable_declarator') {
      const value = n.childForFieldName('value');
      const name = n.childForFieldName('name');
      if (value && name) {
        if (/^(arrow_function|function_expression|function)$/.test(value.type)) {
          // const foo = (...) => {...}  /  const foo = function () {...}
          nodes.push({ type: 'function', name: name.text, file, range: toRange(n) });
          localDefs.add(name.text);
        } else if (value.type === 'class') {
          // const Widget = class {...}: extract as a class so its methods get a
          // `Widget.` container (see enclosingTsClassName) instead of bare ids.
          nodes.push({ type: 'class', name: name.text, file, range: toRange(n) });
          localDefs.add(name.text);
        }
      }
    }
  });

  // Imports & re-exports (source string in field `source`).
  walk(root, (n) => {
    if (n.type === 'import_statement' || n.type === 'export_statement') {
      const source = n.childForFieldName('source');
      if (source) {
        const module = source.text.replace(/^['"`]|['"`]$/g, '');
        edges.push({
          type: 'import',
          fromFile: file,
          toRaw: module,
          range: toRange(n),
          nameRange: toRange(source),
        });
        if (n.type === 'import_statement') imports.push(...tsImportBindings(n, module));
      }
    }
  });

  // Calls & constructions.
  walk(root, (n) => {
    if (n.type === 'call_expression') {
      const callee = n.childForFieldName('function');
      if (!callee) return;
      const calleeText = callee.text;
      // require()/import('...') are imports, not calls.
      if (calleeText === 'require' || calleeText === 'import') {
        const args = n.childForFieldName('arguments');
        const strArg = args?.namedChildren.find((c) => c && c.type === 'string');
        if (strArg) {
          edges.push({
            type: 'import',
            fromFile: file,
            toRaw: strArg.text.replace(/^['"`]|['"`]$/g, ''),
            range: toRange(n),
          });
          return;
        }
      }
      if (callee.type === 'identifier') {
        // Bare call `foo()`: a same-file function/class or an import-bound name.
        const name = callee.text;
        const edge: AstEdge = {
          type: 'call',
          fromFile: file,
          toRaw: name,
          range: toRange(n),
          nameRange: toRange(callee),
          callKind: 'identifier',
          member: name,
        };
        if (localDefs.has(name)) {
          edge.resolvedSameFile = true;
          edge.toFile = file;
        }
        edges.push(edge);
      } else if (callee.type === 'member_expression') {
        // `receiver.method()`: resolvable same-file only when the receiver is
        // `this` (own class); any other receiver is typed — left for LSP.
        const property = callee.childForFieldName('property');
        const object = callee.childForFieldName('object');
        const member = property?.text ?? callee.text;
        edges.push({
          type: 'call',
          fromFile: file,
          toRaw: callee.text,
          range: toRange(n),
          nameRange: toRange(property ?? callee),
          callKind: object?.type === 'this' ? 'this' : 'member',
          member,
        });
      } else {
        // Any other callee form (call chains, parenthesized, etc.): unresolved
        // typed receiver — leave for LSP.
        const member = callee.text.split(/[.?!]/).filter(Boolean).pop() ?? callee.text;
        edges.push({
          type: 'call',
          fromFile: file,
          toRaw: callee.text,
          range: toRange(n),
          nameRange: toRange(callee),
          callKind: 'member',
          member,
        });
      }
    } else if (n.type === 'new_expression') {
      const ctor = n.childForFieldName('constructor');
      if (ctor) {
        const raw = ctor.text;
        const edge: AstEdge = {
          type: 'new',
          fromFile: file,
          toRaw: raw,
          range: toRange(n),
          nameRange: toRange(ctor),
        };
        if (localDefs.has(raw)) {
          edge.resolvedSameFile = true;
          edge.toFile = file;
        }
        edges.push(edge);
      }
    }
  });

  return { nodes, edges, imports };
}

function extractPhp(root: TsNode, file: string): Extraction {
  const nodes: AstNode[] = [];
  const edges: AstEdge[] = [];
  const imports: ImportBinding[] = [];
  const localDefs = new Set<string>();
  let namespace: string | undefined;

  walk(root, (n) => {
    if (n.type === 'namespace_definition') {
      if (!namespace) {
        const nameNode =
          n.childForFieldName('name') ??
          n.namedChildren.find((c) => c && /namespace_name/.test(c.type));
        if (nameNode) namespace = nameNode.text;
      }
    } else if (DEF_TYPES.php.function.includes(n.type as never)) {
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'function', name, file, range: toRange(n) });
        localDefs.add(name);
      }
    } else if (DEF_TYPES.php.method.includes(n.type as never)) {
      // Only named-class members are surfaced; anonymous-class (`new class {…}`)
      // methods have no stable FQN and would collide corpus-wide.
      const container = enclosingPhpClassName(n);
      if (container === undefined) return;
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'method', name, file, range: toRange(n), container });
        localDefs.add(name);
      }
    } else if (DEF_TYPES.php.class.includes(n.type as never)) {
      const name = nameOf(n);
      if (name) {
        nodes.push({ type: 'class', name, file, range: toRange(n) });
        localDefs.add(name);
      }
    }
  });

  // `use` imports, including grouped uses.
  walk(root, (n) => {
    if (n.type === 'namespace_use_declaration') {
      imports.push(...phpUseBindings(n));
      const clauses = n.descendantsOfType(['namespace_use_clause', 'namespace_use_group_clause']);
      if (clauses.length > 0) {
        for (const clause of clauses) {
          const nameNode =
            clause.childForFieldName('name') ??
            clause.namedChildren.find(
              (c) => c && /(qualified_name|name|namespace_name)/.test(c.type)
            );
          if (nameNode) {
            edges.push({
              type: 'import',
              fromFile: file,
              toRaw: nameNode.text,
              range: toRange(clause),
            });
          }
        }
      } else {
        edges.push({
          type: 'import',
          fromFile: file,
          toRaw: n.text.replace(/^use\s+|;\s*$/g, ''),
          range: toRange(n),
        });
      }
    }
  });

  // Calls & object creation.
  walk(root, (n) => {
    if (n.type === 'function_call_expression') {
      // Bare call `foo()`: a same-file function or an import-bound name.
      const callee = n.childForFieldName('function') ?? n.namedChildren[0];
      if (!callee) return;
      const name = callee.text;
      const edge: AstEdge = {
        type: 'call',
        fromFile: file,
        toRaw: name,
        range: toRange(n),
        nameRange: toRange(callee),
        callKind: 'identifier',
        member: name,
      };
      if (localDefs.has(name)) {
        edge.resolvedSameFile = true;
        edge.toFile = file;
      }
      edges.push(edge);
    } else if (
      n.type === 'member_call_expression' ||
      n.type === 'nullsafe_member_call_expression' ||
      n.type === 'scoped_call_expression'
    ) {
      // `$this->m()` / `$this?->m()` / `self::m()` / `static::m()` resolve to a
      // same-class method; `$obj->m()` / `Foo::m()` / `parent::m()` are typed
      // receivers left for LSP.
      const nameNode = n.childForFieldName('name');
      if (!nameNode) return;
      const member = nameNode.text;
      let isThis: boolean;
      let receiverText: string;
      if (n.type === 'scoped_call_expression') {
        const scope = n.childForFieldName('scope');
        const scopeText = scope?.text ?? '';
        isThis = scopeText === 'self' || scopeText === 'static';
        receiverText = `${scopeText}::${member}`;
      } else {
        // member_call_expression / nullsafe_member_call_expression: `$recv->m()`
        const object = n.childForFieldName('object');
        isThis = object?.type === 'variable_name' && object.text === '$this';
        receiverText = `${object?.text ?? ''}->${member}`;
      }
      edges.push({
        type: 'call',
        fromFile: file,
        toRaw: receiverText,
        range: toRange(n),
        nameRange: toRange(nameNode),
        callKind: isThis ? 'this' : 'member',
        member,
      });
    } else if (n.type === 'object_creation_expression') {
      const ctor = n.namedChildren.find((c) => c && /(name|qualified_name)/.test(c.type));
      if (ctor) {
        const raw = ctor.text;
        const edge: AstEdge = { type: 'new', fromFile: file, toRaw: raw, range: toRange(n) };
        if (localDefs.has(raw)) {
          edge.resolvedSameFile = true;
          edge.toFile = file;
        }
        edges.push(edge);
      }
    }
  });

  return { nodes, edges, namespace, imports };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize the tree-sitter runtime and load all grammars once. */
export async function initGrammars(): Promise<Map<AstLang, Parser.Language>> {
  await Parser.init();
  const grammars = new Map<AstLang, Parser.Language>();
  for (const lang of Object.keys(GRAMMAR_WASM) as AstLang[]) {
    grammars.set(lang, await Parser.Language.load(GRAMMAR_WASM[lang]));
  }
  return grammars;
}

/** Load grammars once per process and reuse across calls (cached). */
let grammarsPromise: Promise<Map<AstLang, Parser.Language>> | undefined;
export function getGrammars(): Promise<Map<AstLang, Parser.Language>> {
  grammarsPromise ??= initGrammars();
  return grammarsPromise;
}

/**
 * Parse one source string and extract definition nodes + candidate edges.
 * `hadError` flags a partial parse (tree-sitter is error-tolerant, so partial
 * extractions are still returned).
 */
export function extractSource(
  grammars: Map<AstLang, Parser.Language>,
  source: string,
  relPath: string,
  lang: AstLang
): { extraction: Extraction; hadError: boolean } {
  const grammar = grammars.get(lang);
  if (!grammar) throw new Error(`No grammar loaded for language: ${lang}`);
  const parser = new Parser();
  // web-tree-sitter's Parser and Tree hold WASM heap the JS GC cannot reclaim;
  // both must be explicitly freed or a long-lived process (lux-mcp) leaks one
  // parser per parse across every rebuild.
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(source);
    if (!tree) return { extraction: { nodes: [], edges: [] }, hadError: true };
    try {
      const hadError = tree.rootNode.hasError;
      const extraction =
        lang === 'php' ? extractPhp(tree.rootNode, relPath) : extractTs(tree.rootNode, relPath);
      return { extraction, hadError };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
