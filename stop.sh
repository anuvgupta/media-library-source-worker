#!/usr/bin/env bash

# source worker stop script
set -e

# Check if .env file exists
if [ -f .env ]; then
  # Load environment variables
  export $(cat .env | xargs)
fi

pm2 stop ecosystem.config.js
