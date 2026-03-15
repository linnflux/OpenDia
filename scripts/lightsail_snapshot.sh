#!/bin/bash
# lightsail_snapshot.sh — Create a pre-work snapshot of a Lightsail instance
# SCOPE: Read-only instance listing + snapshot creation ONLY. No deletes, no modifications.
#
# Usage: bash lightsail_snapshot.sh <instance-name> [optional-label]
# Example: bash lightsail_snapshot.sh Acme_Corp_2025
# Example: bash lightsail_snapshot.sh Acme_Corp_2025 theme-update
#
# Snapshot naming: {instance}-pre-work-YYYY-MM-DD-HHMM[-label]

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <instance-name> [optional-label]"
    echo ""
    echo "Available instances:"
    aws lightsail get-instances --query 'instances[].name' --output text | tr '\t' '\n' | sort
    exit 1
fi

INSTANCE_NAME="$1"
LABEL="${2:-}"
TIMESTAMP=$(date +%Y-%m-%d-%H%M)

if [ -n "$LABEL" ]; then
    SNAPSHOT_NAME="${INSTANCE_NAME}-pre-work-${TIMESTAMP}-${LABEL}"
else
    SNAPSHOT_NAME="${INSTANCE_NAME}-pre-work-${TIMESTAMP}"
fi

# Verify instance exists
echo "Verifying instance '${INSTANCE_NAME}' exists..."
INSTANCE_CHECK=$(aws lightsail get-instances --query "instances[?name=='${INSTANCE_NAME}'].name" --output text 2>&1)

if [ -z "$INSTANCE_CHECK" ]; then
    echo "ERROR: Instance '${INSTANCE_NAME}' not found."
    echo ""
    echo "Available instances:"
    aws lightsail get-instances --query 'instances[].name' --output text | tr '\t' '\n' | sort
    exit 1
fi

echo "Instance found: ${INSTANCE_NAME}"
echo "Creating snapshot: ${SNAPSHOT_NAME}"
echo ""

# Create the snapshot
aws lightsail create-instance-snapshot \
    --instance-name "$INSTANCE_NAME" \
    --instance-snapshot-name "$SNAPSHOT_NAME"

echo ""
echo "Snapshot creation initiated: ${SNAPSHOT_NAME}"
echo "Checking status..."

# Check initial status
STATUS=$(aws lightsail get-instance-snapshot \
    --instance-snapshot-name "$SNAPSHOT_NAME" \
    --query 'instanceSnapshot.state' \
    --output text 2>&1)

echo "Status: ${STATUS}"

if [ "$STATUS" = "pending" ]; then
    echo ""
    echo "Snapshot is being created. This typically takes a few minutes."
    echo "To check status later:"
    echo "  aws lightsail get-instance-snapshot --instance-snapshot-name '${SNAPSHOT_NAME}' --query 'instanceSnapshot.state' --output text"
fi
