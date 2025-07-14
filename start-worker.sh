#!/bin/bash
# start-worker.sh - Start the media worker in production mode

IMAGE_NAME="media-worker-authenticated"
CONTAINER_NAME="media-worker"
CONFIG_DIR="./config"

# Check if container is already running
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "⚠️  Worker container is already running"
    echo "Use 'docker logs $CONTAINER_NAME' to view output"
    echo "Use 'docker stop $CONTAINER_NAME' to stop it"
    exit 1
fi

# Remove any stopped container with the same name
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "🧹 Removing stopped container..."
    docker rm $CONTAINER_NAME
fi

echo "🚀 Starting media worker..."

docker run -d \
    --name $CONTAINER_NAME \
    --restart unless-stopped \
    -v "$(pwd)/$CONFIG_DIR:/app/config" \
    -v media-worker-tokens:/app/tokens \
    -e TOKEN_FILE=/app/tokens/.worker-tokens.json \
    $IMAGE_NAME ./start.sh

echo "✅ Worker started successfully!"
echo ""
echo "📊 Useful commands:"
echo "  docker logs $CONTAINER_NAME              # View logs"
echo "  docker logs -f $CONTAINER_NAME           # Follow logs"
echo "  docker stop $CONTAINER_NAME              # Stop worker"
echo "  docker exec -it $CONTAINER_NAME /bin/bash # Access container"