#!/usr/bin/env bash

# build-worker.sh - Complete build script for containerized media worker

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
IMAGE_NAME="media-worker-$STAGE_ENV"
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

# Step 2: Build the base image
print_step "Building base Docker image..."
docker build -t $IMAGE_NAME .
print_success "Base image built successfully"
