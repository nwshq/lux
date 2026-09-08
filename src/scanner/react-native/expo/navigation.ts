import type { SourceDiagnosticV1, SourceLocationV1 } from '../../contracts/program.js';
import type { ExpoDestinationV1, ExpoRouteV1 } from './types.js';
import { normalizePublicPath } from './file-routes.js';

export interface ExpoNavigationExtractionV1 {
  destinations: ExpoDestinationV1[];
  diagnostics: SourceDiagnosticV1[];
}

interface RawDestination {
  expression: string;
  location: SourceLocationV1;
  source: ExpoDestinationV1['source'];
}

/** Extract supported Expo Router uses from source text without treating arbitrary calls as evidence. */
export function extractExpoDestinations(
  filePath: string,
  sourceText: string,
  routes: readonly ExpoRouteV1[]
): ExpoNavigationExtractionV1 {
  const raw: RawDestination[] = [];
  const diagnostics: SourceDiagnosticV1[] = [];
  const push = (expression: string, offset: number, source: ExpoDestinationV1['source']): void => {
    raw.push({ expression, source, location: sourceLocation(filePath, sourceText, offset) });
  };

  // JSX support is deliberately limited to exact href attribute expressions/quoted strings.
  const jsx =
    /<(Link|Redirect)\b[^>]*?\bhref\s*=\s*(?:(["'])([^"']*)\2|\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\})[^>]*>/gu;
  for (const match of sourceText.matchAll(jsx)) {
    push(
      match[3] !== undefined ? JSON.stringify(match[3]) : match[4],
      match.index,
      match[1] === 'Link' ? 'link' : 'redirect'
    );
  }

  const callStart = /\brouter\.(push|replace|navigate)\s*\(/gu;
  for (const match of sourceText.matchAll(callStart)) {
    const open = match.index + match[0].lastIndexOf('(');
    const expression = balancedCallArgument(sourceText, open);
    if (expression !== undefined)
      push(expression, match.index, `router-${match[1]}` as ExpoDestinationV1['source']);
  }

  const destinations: ExpoDestinationV1[] = [];
  for (const candidate of raw.sort(compareRaw)) {
    const parsed = parseDestinationExpression(candidate.expression);
    if (!parsed || isExternalPath(parsed.pathname)) {
      diagnostics.push(
        computedDiagnostic(
          candidate,
          isExternalPath(parsed?.pathname ?? '') ? 'external destination' : 'computed destination'
        )
      );
      continue;
    }
    const target = matchDestination(parsed.pathname, parsed.template, routes);
    if (target.status !== 'resolved') {
      diagnostics.push(computedDiagnostic(candidate, target.reason));
      continue;
    }
    destinations.push({
      pathname: target.route.canonicalPath,
      params: paramsForTarget(target.route, parsed),
      location: candidate.location,
      source: candidate.source,
    });
  }

  return { destinations, diagnostics };
}

interface ParsedExpression {
  pathname: string;
  params: Record<string, string>;
  template?: { staticSegments: string[]; expressions: string[] };
}

function parseDestinationExpression(expression: string): ParsedExpression | undefined {
  const text = expression.trim();
  const literal = /^(["'])(.*?)\1$/su.exec(text);
  if (literal) return { pathname: literal[2], params: {} };

  const template = /^`([^`]*)`$/su.exec(text);
  if (template) {
    const pieces = template[1].split(/\$\{([^{}]+)\}/u);
    const expressions = pieces.filter((_, index) => index % 2 === 1).map((value) => value.trim());
    const staticSegments = pieces.filter((_, index) => index % 2 === 0);
    if (expressions.length === 0) return { pathname: template[1], params: {} };
    if (expressions.some((value) => !/^[$A-Z_a-z][$\w]*$/u.test(value))) return undefined;
    return {
      pathname: staticSegments.join('__EXPO_DYNAMIC__'),
      params: {},
      template: { staticSegments, expressions },
    };
  }

  if (!text.startsWith('{') || !text.endsWith('}') || /\.\.\./u.test(text)) return undefined;
  const pathnameMatch = /(?:^|[,\s])pathname\s*:\s*(["'])(.*?)\1/su.exec(text);
  if (!pathnameMatch) return undefined;
  const params: Record<string, string> = {};
  const paramsMatch = /(?:^|[,\s])params\s*:\s*\{([^{}]*)\}/su.exec(text);
  if (paramsMatch) {
    for (const entry of paramsMatch[1].split(',')) {
      const pair = /^\s*([$A-Z_a-z][$\w]*)\s*(?::\s*([$A-Z_a-z][$\w]*|["'][^"']*["']))?\s*$/u.exec(
        entry
      );
      if (!pair) return undefined;
      params[pair[1]] = pair[2] ? unquote(pair[2]) : pair[1];
    }
  }
  return { pathname: pathnameMatch[2], params };
}

function matchDestination(
  pathname: string,
  template: ParsedExpression['template'],
  routes: readonly ExpoRouteV1[]
): { status: 'resolved'; route: ExpoRouteV1 } | { status: 'refused'; reason: string } {
  if (!template) {
    const normalized = normalizePublicPath(pathname);
    const exact = routes.filter(
      (route) => route.kind === 'route' && route.canonicalPath === normalized
    );
    return exact.length === 1
      ? { status: 'resolved', route: exact[0] }
      : {
          status: 'refused',
          reason: exact.length > 1 ? 'ambiguous route pattern' : 'unresolved destination',
        };
  }

  const segments = pathname.split('/');
  if (
    segments.some(
      (segment) => segment.includes('__EXPO_DYNAMIC__') && segment !== '__EXPO_DYNAMIC__'
    )
  ) {
    return { status: 'refused', reason: 'interpolation must occupy a complete path segment' };
  }
  const candidates = routes.filter((route) => {
    if (route.kind !== 'route') return false;
    const routeSegments = route.canonicalPath.split('/');
    if (segments.length !== routeSegments.length) return false;
    return segments.every((segment, index) =>
      segment === '__EXPO_DYNAMIC__'
        ? /^\[[^.\]]+\]$/u.test(routeSegments[index])
        : segment === routeSegments[index]
    );
  });
  return candidates.length === 1
    ? { status: 'resolved', route: candidates[0] }
    : {
        status: 'refused',
        reason:
          candidates.length > 1
            ? 'template matches multiple routes'
            : 'template has no exact route skeleton',
      };
}

function paramsForTarget(route: ExpoRouteV1, parsed: ParsedExpression): Record<string, string> {
  if (!parsed.template) return parsed.params;
  const result: Record<string, string> = {};
  const segments = parsed.pathname.split('/');
  const routeSegments = route.canonicalPath.split('/');
  let expression = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== '__EXPO_DYNAMIC__') continue;
    const name = /^\[([^\]]+)\]$/u.exec(routeSegments[index])?.[1];
    if (name) result[name] = parsed.template.expressions[expression];
    expression += 1;
  }
  return result;
}

function balancedCallArgument(source: string, open: number): string | undefined {
  let quote = '';
  let templateExpressionDepth = 0;
  let braces = 0;
  for (let index = open + 1; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\' && (quote !== '`' || templateExpressionDepth === 0))
        quote = '';
      else if (quote === '`' && char === '$' && source[index + 1] === '{' && previous !== '\\') {
        templateExpressionDepth += 1;
        index += 1;
      } else if (quote === '`' && char === '}' && templateExpressionDepth > 0)
        templateExpressionDepth -= 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{' || char === '[' || char === '(') braces += 1;
    else if (char === '}' || char === ']') braces -= 1;
    else if (char === ')' && braces === 0) return source.slice(open + 1, index).trim();
    else if (char === ')' && braces > 0) braces -= 1;
  }
  return undefined;
}

function sourceLocation(filePath: string, source: string, offset: number): SourceLocationV1 {
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return { filePath, line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function isExternalPath(pathname: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(pathname);
}

function unquote(value: string): string {
  return /^(["']).*\1$/su.test(value) ? value.slice(1, -1) : value;
}

function computedDiagnostic(candidate: RawDestination, reason: string): SourceDiagnosticV1 {
  return {
    code: 'EXPO_COMPUTED_DESTINATION',
    message: `Expo ${candidate.source} refused: ${reason}`,
    location: candidate.location,
  };
}

function compareRaw(left: RawDestination, right: RawDestination): number {
  return (
    left.location.filePath.localeCompare(right.location.filePath) ||
    left.location.line - right.location.line ||
    left.location.column - right.location.column
  );
}
