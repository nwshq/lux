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

# Check if any indexable content changed.
# Exclude only clearly non-content paths; docs/, notes/, module markdown, etc. should sync.
indexable_changed=$(echo "$changed_files" | grep -vE '^(\.git/|\.lux/|node_modules/|vendor/|dist/|build/)' | grep -E '\.(md|mdx|txt|rst|php|ts|tsx|js|jsx|py|go|rs|java)$' || true)

if [ -z "$indexable_changed" ]; then
    log "INFO" "No indexable content changes detected, skipping rebuild"
    exit 0
fi

changed_count=$(echo "$indexable_changed" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$changed_count" -eq 0 ]; then
    log "WARN" "Indexable change detection produced zero files, skipping rebuild"
    exit 0
fi

log "INFO" "Detected $changed_count indexable file(s) changed"

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

# Attempt to sync index with timeout
log "INFO" "Starting index sync (timeout: ${LUX_REBUILD_TIMEOUT}s)..."

# Create temporary file for rebuild output
rebuild_output=$(mktemp)
trap "rm -f $rebuild_output" EXIT

run_with_timeout() {
    if command -v timeout >/dev/null 2>&1; then
        timeout "$LUX_REBUILD_TIMEOUT" "$@"
        return $?
    fi

    if command -v gtimeout >/dev/null 2>&1; then
        gtimeout "$LUX_REBUILD_TIMEOUT" "$@"
        return $?
    fi

    if command -v python3 >/dev/null 2>&1; then
        python3 - "$LUX_REBUILD_TIMEOUT" "$@" <<'PY'
import subprocess
import sys

timeout_seconds = int(sys.argv[1])
command = sys.argv[2:]
completed = subprocess.run(command, timeout=timeout_seconds)
sys.exit(completed.returncode)
PY
        return $?
    fi

    "$@"
}

# Run sync with timeout
if run_with_timeout "$LUX_CLI" index sync --quiet > "$rebuild_output" 2>&1; then
    rebuild_exit=0
else
    rebuild_exit=$?
fi

# Handle different failure scenarios
if [ $rebuild_exit -eq 0 ]; then
    log "INFO" "Index synced successfully"
    echo "✓ Lux index synced ($changed_count file(s) updated)" >&2
    exit 0
elif [ $rebuild_exit -eq 124 ] || [ $rebuild_exit -eq 143 ]; then
    # Timeout (124 from timeout command, 143 from SIGTERM)
    handle_error "Index sync timed out after ${LUX_REBUILD_TIMEOUT}s" $rebuild_exit
elif [ $rebuild_exit -eq 1 ]; then
    # Generic error - try to extract meaningful message
    if [ -s "$rebuild_output" ]; then
        error_msg=$(head -5 "$rebuild_output" | tr '\n' ' ')
        log "ERROR" "Index sync failed: $error_msg"
        cat "$rebuild_output" >&2
    else
        log "ERROR" "Index sync failed with no output"
    fi
    handle_error "Index sync failed" $rebuild_exit
else
    # Other error codes
    log "ERROR" "Index sync failed with unexpected exit code $rebuild_exit"
    [ -s "$rebuild_output" ] && cat "$rebuild_output" >&2
    handle_error "Index sync failed unexpectedly" $rebuild_exit
fi
