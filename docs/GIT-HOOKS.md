# Git Hooks - Lux Knowledge Platform

## Overview

The Lux Knowledge Platform provides automatic index rebuilding through git post-commit hooks. When you commit changes to your CORPUS repository, the hook automatically detects relevant changes and triggers an index rebuild.

## Features

### Automatic Rebuild Triggers

The post-commit hook automatically rebuilds the index when:
- Files are committed in `knowledge/` directory
- Files are committed in `explorations/` directory
- Files are committed in `implementation-payloads/` directory

### Smart Skip Logic

The hook will skip rebuilding when:
- No CORPUS content was changed (e.g., only README.md or config files)
- Commit message contains skip directives: `[skip lux]`, `[lux skip]`, or `[no index]`
- `LUX_SKIP_REBUILD` environment variable is set
- `lux` CLI is not installed or not found in PATH

### Error Handling

The hook is designed to never block your commits:
- All errors exit with code 0 (allowing commit to succeed)
- Errors are logged to stderr with helpful recovery instructions
- If rebuild fails, user is instructed to run `lux index rebuild` manually

### Timeout Protection

The hook includes configurable timeout protection:
- Default timeout: 300 seconds (5 minutes)
- Configurable via `LUX_REBUILD_TIMEOUT` environment variable
- Timeouts are logged and handled gracefully

## Installation

### Install Hook

To install the post-commit hook in your CORPUS repository:

```bash
# Using default CORPUS location (~⁄CORPUS)
lux hooks install

# Using custom CORPUS location
lux hooks install --corpus /path/to/corpus
```

The hook will be installed at `.git/hooks/post-commit` in your CORPUS repository.

### Uninstall Hook

To remove the post-commit hook:

```bash
# Using default CORPUS location
lux hooks uninstall

# Using custom CORPUS location
lux hooks uninstall --corpus /path/to/corpus
```

### Safety

The install command will:
- Check if a hook already exists
- Refuse to overwrite non-Lux hooks
- Detect if Lux hook is already installed

## Configuration

### Environment Variables

Configure hook behavior via environment variables:

```bash
# Skip all rebuilds (useful for bulk imports)
export LUX_SKIP_REBUILD=1

# Custom lux CLI location
export LUX_CLI=/usr/local/bin/lux

# Enable logging to file
export LUX_LOG_FILE=/path/to/lux-hook.log

# Custom rebuild timeout (in seconds)
export LUX_REBUILD_TIMEOUT=600  # 10 minutes
```

### Per-Commit Skip

Skip rebuild for a specific commit using commit message directives:

```bash
git commit -m "Update documentation [skip lux]"
git commit -m "Bulk import [lux skip]"
git commit -m "WIP changes [no index]"
```

All of these formats are supported:
- `[skip lux]`
- `[lux skip]`
- `[no index]`
- `[skip-lux]`
- `[lux-skip]`

## Usage Examples

### Normal Workflow

```bash
# Make changes to CORPUS
echo "New project info" >> ~/CORPUS/knowledge/10_clients/acme/projects/website/README.md

# Commit changes - hook runs automatically
git commit -m "Update project documentation"

# Output:
# ✓ Lux index rebuilt (1 file(s) updated)
```

### Skip Rebuild for WIP Changes

```bash
# Make temporary changes
echo "TODO: finish this" >> ~/CORPUS/knowledge/10_clients/acme/notes.md

# Skip rebuild since this is work-in-progress
git commit -m "WIP: client notes [skip lux]"

# No rebuild triggered
```

### Bulk Import Workflow

```bash
# Set environment variable to skip all rebuilds
export LUX_SKIP_REBUILD=1

# Import many files
cp -r /tmp/import/* ~/CORPUS/knowledge/10_clients/
git add knowledge/
git commit -m "Bulk import of historical data"

# Manually rebuild once after all imports
unset LUX_SKIP_REBUILD
lux index rebuild
```

### Enable Logging for Debugging

```bash
# Enable logging
export LUX_LOG_FILE=~/lux-hook-debug.log

# Make commits - all hook activity logged
git commit -m "Test commit"

# Review log
cat ~/lux-hook-debug.log
```

Example log output:
```
[2026-02-13 12:00:00] [INFO] Detected 3 CORPUS file(s) changed
[2026-02-13 12:00:00] [INFO] Starting index rebuild (timeout: 300s)...
[2026-02-13 12:00:02] [INFO] Index rebuilt successfully
```

## Hook Architecture

### Execution Flow

1. **Skip Check**: Check `LUX_SKIP_REBUILD` environment variable
2. **Commit Message Check**: Parse commit message for skip directives
3. **Change Detection**: Use `git show` to detect changed files in last commit
4. **Path Filter**: Filter for CORPUS-relevant paths
5. **CLI Check**: Verify `lux` CLI is available and executable
6. **Rebuild**: Execute `lux index rebuild --quiet` with timeout
7. **Error Handling**: Handle exit codes and provide recovery instructions

### Change Detection

The hook uses `git show --name-only --pretty="" HEAD` to detect changed files. This is compatible with:
- Normal commits
- Initial commits (no parent)
- Merge commits
- Rebase operations

### Exit Codes

The hook always exits with code 0 to avoid blocking commits:
- Success: Exit 0 with success message
- Skipped: Exit 0 with no output (unless logging enabled)
- Error: Exit 0 with error message to stderr and recovery instructions

### Rebuild Command

The hook executes:
```bash
timeout $LUX_REBUILD_TIMEOUT lux index rebuild --quiet
```

The `--quiet` flag suppresses progress output, only showing errors.

## Troubleshooting

### Hook Not Executing

Check if hook is installed:
```bash
ls -la ~/CORPUS/.git/hooks/post-commit
```

Check hook is executable:
```bash
chmod +x ~/CORPUS/.git/hooks/post-commit
```

### Rebuild Not Triggering

Enable logging to debug:
```bash
export LUX_LOG_FILE=/tmp/lux-debug.log
git commit -m "Test"
cat /tmp/lux-debug.log
```

Common reasons:
- No CORPUS files were changed
- Commit message contains skip directive
- `LUX_SKIP_REBUILD` is set
- `lux` CLI not in PATH

### Manual Rebuild

If hook fails, manually rebuild:
```bash
lux index rebuild
```

### Hook Conflicts

If you have existing post-commit hooks, you'll need to integrate them manually:

1. Backup existing hook:
   ```bash
   cp ~/CORPUS/.git/hooks/post-commit ~/CORPUS/.git/hooks/post-commit.backup
   ```

2. Edit hook to include both:
   ```bash
   #!/bin/bash

   # Existing hook logic
   # ...

   # Lux hook
   /path/to/lux/bin/post-commit-hook.sh
   ```

## Testing

### Unit Tests

Run hook unit tests:
```bash
./test-post-commit-hook.sh
```

Tests cover:
- CORPUS change detection
- Non-CORPUS file commits
- Skip directives in commit messages
- Environment variable skipping
- Missing CLI handling
- Multiple CORPUS directories

### Integration Tests

Run full integration tests:
```bash
./test-hooks-integration.sh
```

Tests cover:
- Hook installation
- Hook execution
- Skip behavior
- Uninstallation
- Error handling

## Performance Considerations

### Rebuild Duration

Typical rebuild times:
- Small CORPUS (< 100 files): 1-2 seconds
- Medium CORPUS (100-1000 files): 2-10 seconds
- Large CORPUS (> 1000 files): 10-60 seconds

### Optimization Tips

1. **Use skip directives** for WIP commits
2. **Bulk operations**: Set `LUX_SKIP_REBUILD=1` and rebuild once
3. **Filter paths carefully**: Only CORPUS content triggers rebuilds
4. **Adjust timeout**: Increase `LUX_REBUILD_TIMEOUT` for large repositories

## Security Considerations

### Hook Safety

The post-commit hook:
- Never fails the commit (always exits 0)
- Does not modify commit history
- Does not push changes automatically
- Runs with user's permissions

### Environment Variables

Be cautious with:
- `LUX_CLI`: Can execute arbitrary commands (sanitized to path only)
- `LUX_LOG_FILE`: Can write to any location user has access to

### Multi-User Repositories

The hook:
- Is installed per-repository (not shared via git)
- Each user must install the hook separately
- Each user's `lux` CLI configuration is independent

## Advanced Usage

### Custom Hook Integration

Integrate Lux hook with existing hooks:

```bash
#!/bin/bash
# .git/hooks/post-commit

# Run existing hooks
./pre-existing-hook.sh

# Run Lux hook
export LUX_LOG_FILE=/var/log/lux-hook.log
bash /path/to/lux/bin/post-commit-hook.sh

# Run other hooks
./another-hook.sh
```

### Conditional Rebuilding

Only rebuild on main branch:

```bash
#!/bin/bash
# .git/hooks/post-commit

current_branch=$(git symbolic-ref --short HEAD)

if [ "$current_branch" = "main" ]; then
    bash /path/to/lux/bin/post-commit-hook.sh
else
    export LUX_SKIP_REBUILD=1
    bash /path/to/lux/bin/post-commit-hook.sh
fi
```

### Remote Rebuild

Trigger rebuild on remote server:

```bash
#!/bin/bash
# .git/hooks/post-commit

# Skip local rebuild
export LUX_SKIP_REBUILD=1
bash /path/to/lux/bin/post-commit-hook.sh

# Trigger remote rebuild
ssh server "cd /path/to/corpus && lux index rebuild"
```

## See Also

- [CLI Documentation](./CLI.md) - Command-line interface
- [Scanner Documentation](./SCANNER-API.md) - CORPUS scanner details
- [Database Schema](../src/db/schema.sql) - Database structure
