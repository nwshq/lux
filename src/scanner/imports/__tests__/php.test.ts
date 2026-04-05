import { describe, it, expect } from 'vitest';
import { parsePhpImports } from '../php.js';

describe('PHP Import Parser', () => {
  it('should parse simple use statement', () => {
    const content = `<?php
use App\\Module\\Users\\UserService;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('App\\Module\\Users\\UserService');
    expect(imports[0].symbols).toEqual(['UserService']);
  });

  it('should parse multiple use statements', () => {
    const content = `<?php
use App\\Module\\Users\\UserService;
use App\\Module\\Orders\\OrderRepository;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(2);
    expect(imports[0].rawImport).toBe('App\\Module\\Users\\UserService');
    expect(imports[1].rawImport).toBe('App\\Module\\Orders\\OrderRepository');
  });

  it('should parse grouped use statements', () => {
    const content = `<?php
use App\\Module\\Users\\{UserService, UserRepository, UserFactory};
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(3);
    expect(imports[0].rawImport).toBe('App\\Module\\Users\\UserService');
    expect(imports[0].symbols).toEqual(['UserService']);
    expect(imports[1].rawImport).toBe('App\\Module\\Users\\UserRepository');
    expect(imports[2].rawImport).toBe('App\\Module\\Users\\UserFactory');
  });

  it('should parse function use statement', () => {
    const content = `<?php
use function App\\Helpers\\formatDate;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('App\\Helpers\\formatDate');
    expect(imports[0].symbols).toEqual(['formatDate']);
  });

  it('should parse const use statement', () => {
    const content = `<?php
use const App\\Config\\MAX_RETRIES;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('App\\Config\\MAX_RETRIES');
    expect(imports[0].symbols).toEqual(['MAX_RETRIES']);
  });

  it('should ignore closure use statements', () => {
    const content = `<?php
$fn = function($x) use ($db, $logger) {
    return $x;
};
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(0);
  });

  it('should ignore single-line comments', () => {
    const content = `<?php
// use App\\Module\\Disabled\\Service;
use App\\Module\\Active\\Service;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('App\\Module\\Active\\Service');
  });

  it('should ignore lines starting with # comments', () => {
    const content = `<?php
# use App\\Module\\Commented\\Service;
use App\\Module\\Real\\Service;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('App\\Module\\Real\\Service');
  });

  it('should ignore block comments', () => {
    const content = `<?php
/* use App\\Module\\Disabled\\Service; */
use App\\Module\\Active\\Service;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('App\\Module\\Active\\Service');
  });

  it('should handle multi-line block comments', () => {
    const content = `<?php
/*
use App\\Module\\Disabled\\Service;
use App\\Module\\AlsoDisabled\\Service;
*/
use App\\Module\\Active\\Service;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].rawImport).toBe('App\\Module\\Active\\Service');
  });

  it('should handle lines starting with * (docblock)', () => {
    const content = `<?php
/**
 * use App\\Module\\Disabled\\Service;
 */
use App\\Module\\Active\\Service;
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(1);
  });

  it('should return empty for content with no imports', () => {
    const content = `<?php
class MyClass {
    public function foo() {}
}
`;
    const imports = parsePhpImports(content);
    expect(imports).toHaveLength(0);
  });

  it('should set resolvedModule to null', () => {
    const content = `<?php
use App\\Module\\Users\\UserService;
`;
    const imports = parsePhpImports(content);
    expect(imports[0].resolvedModule).toBeNull();
  });
});
