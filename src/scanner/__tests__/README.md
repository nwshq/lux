# Scanner Tests

Comprehensive test suite for the `GeneralScanner` class.

## Test Coverage

- **Statement Coverage**: 87.64%
- **Branch Coverage**: 78.04%
- **Function Coverage**: 100%
- **Line Coverage**: 90.47%
- **Total Tests**: 41 passing tests

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage
```

## Test Structure

### Constructor Tests

- Scanner initialization with and without root path

### scan() Method Tests

- **Basic Scanning**: Clients, projects, communications, and knowledge entries
- **File Discovery**: Multiple candidate files (README.md, AGENTS.md, CLAUDE.md)
- **Frontmatter Parsing**: YAML frontmatter extraction and metadata handling
- **Special Directories**: Skipping `communications`, `_meta`, `archive`, etc.
- **Type Inference**: Automatic type detection from filenames and paths
- **Title Extraction**: Slug-to-title conversion and date prefix removal
- **Edge Cases**: Empty content directory, missing files, directory-only references

### index() Method Tests

- **Validation**: Input validation for database and scan results
- **Entity Indexing**: Correct insertion of all entity types
- **Dependency Tracking**: Client/project relationships and foreign keys
- **Error Handling**: Detailed error messages with partial index information
- **Data Validation**: Type checking for all required fields
- **Metadata Preservation**: Frontmatter and content passthrough

### Private Helper Methods Tests

- `slugToTitle()`: Slug to title case conversion
- `extractTitleFromFilename()`: Date prefix removal and title extraction
- `inferCommType()`: Communication type inference from filename
- `inferKnowledgeType()`: Knowledge type inference from path and frontmatter

## Test Fixtures

Test fixtures are located in `fixtures/` directory and mirror the expected content directory structure:

```
fixtures/
└── knowledge/
    ├── 10_clients/
    │   └── test-client-1/
    │       ├── README.md
    │       ├── test-project/
    │       │   └── README.md
    │       └── communications/
    │           └── 2024-01-15_meeting-notes.md
    └── 20_methodology/
        └── agile-process.md
```

## Temporary Test Files

Tests create temporary directories for isolated testing. These are automatically cleaned up and ignored via `.gitignore`.

## Key Test Scenarios

1. **Multi-file Priority**: Tests that README.md is preferred over AGENTS.md over CLAUDE.md
2. **Slug Conversion**: Tests conversion of kebab-case slugs to Title Case
3. **Date Extraction**: Tests extraction of dates from communication filenames (YYYY-MM-DD format)
4. **Type Inference**: Tests automatic type detection for communications and knowledge
5. **Relationship Tracking**: Tests client→project and project→communication relationships
6. **Error Context**: Tests that errors include helpful context about what succeeded before failure
7. **Validation**: Tests comprehensive input validation at all levels

## Coverage Notes

Uncovered lines (~10%) primarily consist of:

- Error path branches that are difficult to trigger in tests
- Edge cases in error message formatting
- Non-critical logging or debug paths

The test suite provides comprehensive coverage of all critical paths and business logic.
