#!/usr/bin/env bash
# Lux Knowledge Platform - Git post-commit hook
# Automatically rebuilds index after CORPUS commits

# Configuration
LUX_CLI="${LUX_CLI:-lux}"
LUX_SKIP_REBUILD="${LUX_SKIP_REBUILD:-}"
LUX_LOG_FILE="${LUX_LOG_FILE:-}"
LUX_REBUILD_TIMEOUT="${LUX_REBUILD_TIMEOUT:-300}"  # 5 minutes default

# Logging function
log() {
    local level="$1"
    shift
    local msg="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    if [ -n "$LUX_LOG_FILE" ]; then
        echo "[$timestamp] [$level] $msg" >> "$LUX_LOG_FILE"
    fi

    # Always output to stderr for visibility
    if [ "$level" = "ERROR" ]; then
        echo "Error: $msg" >&2
    elif [ "$level" = "WARN" ]; then
        echo "Warning: $msg" >&2
    fi
}

# Error exit handler - always exits with 0 to avoid blocking commits
handle_error() {
    local msg="$1"
    local exit_code="${2:-1}"
    log "ERROR" "$msg (exit code: $exit_code)"
    echo "✗ Lux hook error: $msg" >&2
    echo "  The commit succeeded, but index rebuild failed." >&2
    echo "  Run 'lux index rebuild' manually to sync the index." >&2
    exit 0  # Never fail the commit
}

# Check if rebuild should be skipped
if [ -n "$LUX_SKIP_REBUILD" ]; then
    log "INFO" "Rebuild skipped (LUX_SKIP_REBUILD is set)"
    exit 0
fi

# Check if commit message indicates skip
commit_msg=$(git log -1 --pretty=%B)
if echo "$commit_msg" | grep -qE '\[skip.?lux\]|\[lux.?skip\]|\[no.?index\]'; then
    log "INFO" "Rebuild skipped (commit message contains skip directive)"
    exit 0
fi

# Detect changed files in the last commit
# Use git show for compatibility with initial commits (git diff-tree fails on commits with no parent)
changed_files=$(git show --name-only --pretty="" HEAD 2>&1)
if [ $? -ne 0 ]; then
    handle_error "Failed to detect changed files in commit" $?
fi

# Validate that we got actual file paths (not empty or error message)
if [ -z "$changed_files" ]; then
    log "WARN" "No files detected in commit, skipping rebuild"
    exit 0
fi

# Check if any relevant files were changed
# Relevant paths: knowledge/, explorations/, implementation-payloads/
if ! echo "$changed_files" | grep -qE '^(knowledge/|explorations/|implementation-payloads/)'; then
    log "INFO" "No CORPUS content changes detected, skipping rebuild"
    exit 0
fi

# Count changed files
changed_count=$(echo "$changed_files" | grep -cE '^(knowledge/|explorations/|implementation-payloads/)' || echo 0)
if [ "$changed_count" -eq 0 ]; then
    log "WARN" "Pattern matched but count is 0, possible parsing error"
    exit 0
fi

log "INFO" "Detected $changed_count CORPUS file(s) changed"

# Check if lux CLI is available
if ! command -v "$LUX_CLI" &> /dev/null; then
    log "ERROR" "lux CLI not found. Cannot rebuild index."
    log "INFO" "Install lux or set LUX_CLI environment variable."
    echo "Warning: lux CLI not found. Run 'npm install -g .' to install." >&2
    exit 0  # Don't fail the commit
fi

# Verify lux CLI is executable
if ! "$LUX_CLI" --version &> /dev/null; then
    log "ERROR" "lux CLI found but not executable or misconfigured"
    echo "Warning: lux CLI not working. Check your installation." >&2
    exit 0  # Don't fail the commit
fi

# Attempt to rebuild index with timeout
log "INFO" "Starting index rebuild (timeout: ${LUX_REBUILD_TIMEOUT}s)..."

# Create temporary file for rebuild output
rebuild_output=$(mktemp)
trap "rm -f $rebuild_output" EXIT

# Run rebuild with timeout
if timeout "$LUX_REBUILD_TIMEOUT" "$LUX_CLI" index rebuild --quiet > "$rebuild_output" 2>&1; then
    rebuild_exit=0
else
    rebuild_exit=$?
fi

# Handle different failure scenarios
if [ $rebuild_exit -eq 0 ]; then
    log "INFO" "Index rebuilt successfully"
    echo "✓ Lux index rebuilt ($changed_count file(s) updated)" >&2
    exit 0
elif [ $rebuild_exit -eq 124 ] || [ $rebuild_exit -eq 143 ]; then
    # Timeout (124 from timeout command, 143 from SIGTERM)
    handle_error "Index rebuild timed out after ${LUX_REBUILD_TIMEOUT}s" $rebuild_exit
elif [ $rebuild_exit -eq 1 ]; then
    # Generic error - try to extract meaningful message
    if [ -s "$rebuild_output" ]; then
        error_msg=$(head -5 "$rebuild_output" | tr '\n' ' ')
        log "ERROR" "Index rebuild failed: $error_msg"
        cat "$rebuild_output" >&2
    else
        log "ERROR" "Index rebuild failed with no output"
    fi
    handle_error "Index rebuild failed" $rebuild_exit
else
    # Other error codes
    log "ERROR" "Index rebuild failed with unexpected exit code $rebuild_exit"
    [ -s "$rebuild_output" ] && cat "$rebuild_output" >&2
    handle_error "Index rebuild failed unexpectedly" $rebuild_exit
fi
