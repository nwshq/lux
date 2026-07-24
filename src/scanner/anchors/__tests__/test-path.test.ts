import { describe, it, expect } from 'vitest';
import { isTestPath } from '../test-path.js';

// The conservative path-based test classifier (issue #77 item #3). Two axes: it must CATCH the real
// PHP (Laravel/Pest/PHPUnit) + TS/JS (vitest/jest) conventions, and it must NOT strip product code
// whose name merely contains "test".
describe('isTestPath', () => {
  it('catches the real test conventions of both ecosystems lux indexes', () => {
    const testPaths = [
      // vitest/jest colocated tests (this repo's own convention).
      'src/cli/__tests__/anchors-envelope.test.ts',
      'src/scanner/anchors/__tests__/fusion.ts',
      // TS/JS .test. / .spec. filename infixes.
      'app/frontend/components/Button.test.tsx',
      'app/frontend/components/Button.spec.ts',
      'resources/js/utils.spec.js',
      // Laravel test directories.
      'tests/Feature/CheckoutTest.php',
      'tests/Unit/MoneyTest.php',
      // generic test/ tree.
      'packages/core/test/helpers.php',
      // PHPUnit/Pest *Test.php suffix (no test dir — suffix alone must catch it).
      'app/Domain/Billing/InvoiceTest.php',
      // Pest .test.php infix.
      'app/Domain/Billing/Invoice.test.php',
      // PHPUnit/Laravel base test classes *TestCase.php (ends Case.php, not caught by *Test.php).
      'tests/TestCase.php',
      'src/Testing/FeatureTestCase.php',
    ];
    for (const p of testPaths) expect(isTestPath(p), p).toBe(true);
  });

  it('does NOT strip product code whose name merely contains "test"', () => {
    const productPaths = [
      // exact-segment dir check spares a `Testing/` directory.
      'app/Services/Testing/TestimonialService.php',
      // case-sensitive Test.php suffix spares these.
      'app/Models/Contest.php',
      'app/Support/latest.php',
      'app/Http/Controllers/OrderController.php',
      'app/Services/Payments/StripeService.php',
      // 'test' as a substring of a segment, not a whole segment.
      'app/Fastest/Runner.php',
    ];
    for (const p of productPaths) expect(isTestPath(p), p).toBe(false);
  });

  it('normalizes backslash separators and tolerates empty input', () => {
    expect(isTestPath('src\\cli\\__tests__\\x.ts')).toBe(true);
    expect(isTestPath('')).toBe(false);
  });
});
