#!/usr/bin/env bash

# start-worker.sh - Start the media worker in production mode

STAGE_ENV="${STAGE:-prod}"

IMAGE_NAME="media-worker-authenticated-$STAGE_ENV"
CONTAINER_NAME="media-worker"
CONFIG_DIR="./config"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️ $1${NC}"
}

# Check if config exists
if [ ! -f "$CONFIG_DIR/$STAGE_ENV.json" ]; then
    print_error "Configuration file not found at $CONFIG_DIR/$STAGE_ENV.json"
    exit 1
fi

# Extract libraryPath from config
if command -v jq &> /dev/null; then
    HOST_LIBRARY_PATH=$(jq -r '.libraryPath' "$CONFIG_DIR/$STAGE_ENV.json")
else
    # Fallback to grep/sed method
    HOST_LIBRARY_PATH=$(cat "$CONFIG_DIR/$STAGE_ENV.json" | grep -o '"libraryPath"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"libraryPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

if [ -z "$HOST_LIBRARY_PATH" ] || [ "$HOST_LIBRARY_PATH" = "null" ]; then
    print_error "libraryPath not found in config file"
    exit 1
fi

# Check if container is already running
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    print_warning "Worker container is already running"
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
echo "📁 Host library path: $HOST_LIBRARY_PATH"
echo "📁 Container library path: /media"

# FIXED: Use the HOST path for volume mounting, but set LIBRARY_PATH to the container path
MSYS_NO_PATHCONV=1 docker run -d \
    --name $CONTAINER_NAME \
    --restart unless-stopped \
    -v "$(pwd)/$CONFIG_DIR:/app/config" \
    -v media-worker-tokens:/app/tokens \
    -v "$HOST_LIBRARY_PATH:/media" \
    -e TOKEN_FILE=/app/tokens/.worker-tokens.json \
    -e LIBRARY_PATH=/media \
    -e STAGE="$STAGE_ENV" \
    $IMAGE_NAME bash ./start.sh

print_success "Worker started successfully!"
echo ""
echo "📊 Useful commands:"
echo "  docker logs $CONTAINER_NAME              # View logs"
echo "  docker logs -f $CONTAINER_NAME           # Follow logs"
echo "  docker stop $CONTAINER_NAME              # Stop worker"
echo "  docker exec -it $CONTAINER_NAME /bin/bash # Access container"