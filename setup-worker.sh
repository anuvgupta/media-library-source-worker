#!/usr/bin/env bash

# setup-worker.sh - Complete setup script for containerized media worker

set -e

# Check if .env file exists
if [ -f .env ]; then
  # Load environment variables
  export $(cat .env | xargs)
fi

echo "🐳 Media Worker Docker Setup"
echo "============================="

STAGE_ENV="${STAGE:-prod}"

# Configuration
DOCKER_HUB_IMAGE="agwx2/media-library-source-worker:latest"
IMAGE_NAME="media-worker-$STAGE_ENV"
CONTAINER_NAME="media-worker-setup-$STAGE_ENV"
AUTHENTICATED_IMAGE="media-worker-authenticated-$STAGE_ENV"
CONFIG_DIR="./config"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_step() {
    echo -e "${BLUE}==> $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Step 1: Check if config exists
print_step "Checking configuration..."
if [ ! -f "$CONFIG_DIR/$STAGE_ENV.json" ]; then
    print_error "Configuration file not found at $CONFIG_DIR/$STAGE_ENV.json"
    print_warning "Please ensure your config file exists before running setup"
    exit 1
fi
print_success "Configuration file found"

# Extract libraryPath from config using jq
print_step "Reading library path from config..."
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

print_success "Host library path found: $HOST_LIBRARY_PATH"
print_success "Container library path will be: /media"

# # Step 2: Check for base image and pull from Docker Hub if needed
# print_step "Checking for base image..."
# if docker images --format '{{.Repository}}' | grep -q "^${IMAGE_NAME}$"; then
#     print_success "Base image found locally"
# else
#     print_warning "Base image not found locally"
    
#     # Check if DOCKER_HUB_IMAGE is set in environment or .env
#     if [ -z "$DOCKER_HUB_IMAGE" ]; then
#         print_error "DOCKER_HUB_IMAGE not set in environment variables"
#         print_warning "Please set DOCKER_HUB_IMAGE in your .env file or environment"
#         echo "Example: DOCKER_HUB_IMAGE=username/media-worker:latest"
#         exit 1
#     fi
    
#     print_step "Pulling base image from Docker Hub: $DOCKER_HUB_IMAGE"
#     if docker pull "$DOCKER_HUB_IMAGE"; then
#         # Tag the pulled image with our local name
#         docker tag "$DOCKER_HUB_IMAGE" "$IMAGE_NAME"
#         print_success "Base image pulled and tagged successfully"
#     else
#         print_error "Failed to pull image from Docker Hub"
#         print_warning "You can either:"
#         echo "1. Build the image locally: docker build -t $IMAGE_NAME ."
#         echo "2. Check your DOCKER_HUB_IMAGE setting: $DOCKER_HUB_IMAGE"
#         exit 1
#     fi
# fi

# # Step 2: Build the base image
# print_step "Building base Docker image..."
# docker build -t $IMAGE_NAME .
# print_success "Base image built successfully"

# Step 3: Check if we need to clean up existing containers
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    print_warning "Removing existing setup container..."
    docker rm -f $CONTAINER_NAME
fi

# Step 4: Run interactive setup
print_step "Starting interactive setup container..."
echo ""
echo -e "${YELLOW}Please enter your username and password if prompted.${NC}"
echo ""
echo -e "${BLUE}Press Enter to continue...${NC}"
read

# FIXED: Use HOST_LIBRARY_PATH for volume mounting, but set LIBRARY_PATH to container path
MSYS_NO_PATHCONV=1 docker run -it \
    --name $CONTAINER_NAME \
    -v "$(pwd)/$CONFIG_DIR:/app/config" \
    -v media-worker-tokens:/app/tokens \
    -v "$HOST_LIBRARY_PATH:/media" \
    -e TOKEN_FILE=/app/tokens/.worker-tokens.json \
    -e LIBRARY_PATH=/media \
    -e STAGE="$STAGE_ENV" \
    $IMAGE_NAME bash ./login.sh

# Step 5: Commit the authenticated container
print_step "Creating authenticated image..."
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    docker commit $CONTAINER_NAME $AUTHENTICATED_IMAGE
    print_success "Authenticated image created: $AUTHENTICATED_IMAGE"
    
    # Clean up setup container
    docker rm $CONTAINER_NAME
    print_success "Setup container cleaned up"
else
    print_error "Setup container not found. Did the interactive setup complete?"
    exit 1
fi
