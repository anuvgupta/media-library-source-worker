#!/usr/bin/env bash

# source worker start script
set -e

# Check if .env file exists
if [ -f .env ]; then
  # Load environment variables
  export $(cat .env | xargs)
fi

npm run start
