#!/bin/bash
# logs.sh - View worker logs

CONTAINER_NAME="media-worker"

if [ "$1" = "-f" ] || [ "$1" = "--follow" ]; then
    echo "📋 Following worker logs (Ctrl+C to stop)..."
    docker logs -f $CONTAINER_NAME
else
    echo "📋 Recent worker logs:"
    docker logs --tail 50 $CONTAINER_NAME
fi