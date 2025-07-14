#!/bin/bash
# stop-worker.sh - Stop the media worker

CONTAINER_NAME="media-worker"

echo "🛑 Stopping media worker..."

if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    docker stop $CONTAINER_NAME
    echo "✅ Worker stopped successfully!"
else
    echo "ℹ️  Worker container is not running"
fi