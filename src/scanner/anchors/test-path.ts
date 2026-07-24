// src/scanner/anchors/test-path.ts
//
// The ONE shared test-file classifier for the anchor surface (issue #77 item #3). `lux anchors`
// excludes test files from results BY DEFAULT so the `--limit` cap means "N product-code anchors"
// rather than being flooded by test classes/methods (the consumer's measured complaint). The default
// is restored with `--include-tests` (CLI) / `include_tests` (MCP).
//
// The structural overlay records NO test classification on nodes or files today — structural_nodes
// (mig 008) carries node_type/symbol_kind/file_path/qualified_name only, and the anchor text rows
// (mig 014) carry the prepared/identifier columns; neither materializer tags a node as test-vs-source.
// So classification is a CONSERVATIVE path-based heuristic here, keyed on the file path the anchor node
// already carries (structural_nodes.file_path). Path-only by design: it needs no new schema, no
// re-index, and works identically on the cross-repo read path.
//
// Patterns cover the real conventions of the two ecosystems lux indexes — PHP (Laravel/Pest/PHPUnit)
// and TS/JS (vitest/jest). Each is deliberately narrow to avoid stripping product code whose name
// merely contains "test" (e.g. app/Services/Testing/TestimonialService.php must NOT be excluded):
// directory checks are exact path SEGMENTS (never substrings) and the PHP suffix checks are
// case-SENSITIVE on the CamelCase `Test`/`TestCase` boundary (so `contest.php`/`latest.php` are safe).

/**
 * Is `filePath` a test file under the conventions lux indexes? Conservative and path-only (the overlay
 * stores no test flag). Patterns, with rationale:
 *
 *  1. `__tests__/` directory segment — the vitest/jest colocated-test convention (this repo uses it,
 *     e.g. a `__tests__/` folder holding `*.test.ts` files).
 *  2. a `test/` or `tests/` directory segment — Laravel's `tests/Feature`,`tests/Unit`; generic
 *     `test/` trees. EXACT segment match, so `Testing/`, `contest/`, `latest/` do not trigger it.
 *  3. `.test.` / `.spec.` infix in the filename — the vitest/jest/Pest file-naming convention
 *     (`foo.test.ts`, `bar.spec.tsx`, `Thing.test.php`), case-insensitive on the infix.
 *  4. a `*Test.php` filename suffix — the PHPUnit/Pest class convention (`UserTest.php`,
 *     `OrderControllerTest.php`). Case-SENSITIVE `Test` so `contest.php`/`latest.php` are NOT matched.
 *  5. a `*TestCase.php` filename suffix — PHPUnit/Laravel base test classes (`TestCase.php`,
 *     `FeatureTestCase.php`), which end in `Case.php` and so are not caught by pattern 4.
 */
export function isTestPath(filePath: string): boolean {
  if (!filePath) return false;
  // Normalize any backslash separators to POSIX so segment logic is uniform. Corpus file paths are
  // already POSIX; this only hardens against a stray Windows-style path reaching the classifier.
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const base = segments[segments.length - 1];

  // 1 + 2 — a test directory segment anywhere in the path (exact segment, never a substring).
  for (const seg of segments) {
    if (seg === '__tests__' || seg === 'test' || seg === 'tests') return true;
  }
  // 3 — `.test.` / `.spec.` filename infix (TS/JS + Pest).
  if (/\.(test|spec)\./i.test(base)) return true;
  // 4 — PHPUnit/Pest `*Test.php` suffix (case-sensitive T to spare `contest.php`/`latest.php`).
  if (/Test\.php$/.test(base)) return true;
  // 5 — PHPUnit/Laravel `*TestCase.php` base classes (case-sensitive).
  if (/TestCase\.php$/.test(base)) return true;

  return false;
}
