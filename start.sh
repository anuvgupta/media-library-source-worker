#!/usr/bin/env bash

# source worker start script
set -e

# Check if .env file exists
if [ -f .env ]; then
  # Load environment variables
  export $(cat .env | xargs)
fi

echo "🔧 Initializing PM2..."
# Initialize PM2 for this user (creates ~/.pm2 directory and config files)
pm2 ping || true
echo "✅ PM2 initialized"

echo "🚀 Starting media worker with PM2..."
pm2 start ecosystem.config.js --env production

# Keep container running by following logs
echo "📋 Following PM2 logs (Ctrl+C to stop)..."
pm2 logs