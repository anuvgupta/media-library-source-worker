#!/usr/bin/env bash

# setup.sh - Complete setup script for containerized media worker

set -e

# Check if .env file exists
if [ -f .env ]; then
  # Load environment variables
  export $(cat .env | xargs)
fi

echo "🐳 Media Worker Docker Setup"
echo "============================="

# Configuration
IMAGE_NAME="media-worker"
CONTAINER_NAME="media-worker-setup"
AUTHENTICATED_IMAGE="media-worker-authenticated"
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
if [ ! -f "$CONFIG_DIR/dev.json" ]; then
    print_error "Configuration file not found at $CONFIG_DIR/dev.json"
    print_warning "Please ensure your config file exists before running setup"
    exit 1
fi
print_success "Configuration file found"

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
echo -e "${YELLOW}📋 SETUP INSTRUCTIONS:${NC}"
echo "1. The container will start and run the login script automatically"
echo "2. Enter your username and password when prompted"
echo "3. Wait for authentication to complete"
echo "4. Type 'exit' when you see the success message"
echo ""
echo -e "${BLUE}Press Enter to continue...${NC}"
read

# Run container interactively
docker run -it \
    --name $CONTAINER_NAME \
    -v "$(pwd)/$CONFIG_DIR:/app/config" \
    -v media-worker-tokens:/app/tokens \
    -e TOKEN_FILE=/app/tokens/.worker-tokens.json \
    $IMAGE_NAME ./login.sh

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

# # Step 6: Provide usage instructions
# echo ""
# echo -e "${GREEN}🎉 Setup Complete!${NC}"
# echo ""
# echo -e "${BLUE}Usage Commands:${NC}"
# echo ""
# echo "# Run worker mode (continuous processing):"
# echo "docker run --name media-worker -d \\"
# echo "  -v $(pwd)/$CONFIG_DIR:/app/config \\"
# echo "  -v media-worker-tokens:/app/tokens \\"
# echo "  -e TOKEN_FILE=/app/tokens/.worker-tokens.json \\"
# echo "  $AUTHENTICATED_IMAGE"
# echo ""
# echo "# Check worker status:"
# echo "docker run --rm \\"
# echo "  -v $(pwd)/$CONFIG_DIR:/app/config \\"
# echo "  -v media-worker-tokens:/app/tokens \\"
# echo "  -e TOKEN_FILE=/app/tokens/.worker-tokens.json \\"
# echo "  $AUTHENTICATED_IMAGE node main.js status"
# echo ""
# echo "# Upload a specific media file:"
# echo "docker run --rm \\"
# echo "  -v $(pwd)/$CONFIG_DIR:/app/config \\"
# echo "  -v media-worker-tokens:/app/tokens \\"
# echo "  -v /path/to/your/media:/media \\"
# echo "  -e TOKEN_FILE=/app/tokens/.worker-tokens.json \\"
# echo "  $AUTHENTICATED_IMAGE node main.js upload-media /media/movie.mp4 <movie-id>"
# echo ""
# echo "# Scan library:"
# echo "docker run --rm \\"
# echo "  -v $(pwd)/$CONFIG_DIR:/app/config \\"
# echo "  -v media-worker-tokens:/app/tokens \\"
# echo "  -v /path/to/your/library:/library \\"
# echo "  -e TOKEN_FILE=/app/tokens/.worker-tokens.json \\"
# echo "  $AUTHENTICATED_IMAGE node main.js scan-library /library"
# echo ""
# echo -e "${YELLOW}💡 Tips:${NC}"
# echo "- Tokens are stored in the 'media-worker-tokens' Docker volume"
# echo "- Mount your media library using -v /host/path:/container/path"
# echo "- Use -d flag to run worker in detached mode"
# echo "- Use 'docker logs media-worker' to view worker output"