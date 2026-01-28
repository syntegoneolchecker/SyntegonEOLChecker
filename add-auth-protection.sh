#!/bin/bash

# Script to add authentication protection to user-facing endpoints

# List of endpoints to protect (user-facing only)
ENDPOINTS=(
    "initialize-job.js"
    "job-status.js"
    "get-groq-usage.js"
    "get-auto-check-state.js"
    "set-auto-check-state.js"
    "reset-database.js"
    "clear-logs.js"
)

cd netlify/functions

for endpoint in "${ENDPOINTS[@]}"; do
    echo "Processing $endpoint..."

    # Check if file exists
    if [ ! -f "$endpoint" ]; then
        echo "  Warning: $endpoint not found, skipping"
        continue
    fi

    # Check if already protected
    if grep -q "requireAuth" "$endpoint"; then
        echo "  Already protected, skipping"
        continue
    fi

    # Add import at the top (after existing requires)
    # Find the last require statement and add our import after it
    awk '
        /^const.*require/ { last_require=NR }
        END { print last_require }
    ' "$endpoint" > /tmp/last_require_line

    LAST_REQ=$(cat /tmp/last_require_line)

    if [ -n "$LAST_REQ" ]; then
        # Insert the requireAuth import after the last require
        sed -i "${LAST_REQ}a const { requireAuth } = require('./lib/auth-middleware');" "$endpoint"
        echo "  Added requireAuth import"
    fi

    # Find exports.handler line and rename it
    sed -i 's/^exports\.handler = async function/const protectedHandler = async function/' "$endpoint"
    sed -i 's/^exports\.handler = async /const protectedHandler = async /' "$endpoint"

    # Add the wrapped export at the end of the file
    echo "" >> "$endpoint"
    echo "// Protect with authentication" >> "$endpoint"
    echo "exports.handler = requireAuth(protectedHandler);" >> "$endpoint"

    echo "  ✓ Protected $endpoint"
done

echo "Done!"
