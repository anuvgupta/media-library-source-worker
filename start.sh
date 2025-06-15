#!/usr/bin/env bash

# source worker start script
set -e

# Check if .env file exists
if [ -f .env ]; then
  # Load environment variables
  export $(cat .env | xargs)
fi

# Validate required environment variables
if [ -z "$AWS_ACCESS_KEY_ID" ]; then
  echo "Error: AWS_ACCESS_KEY_ID not set"
  exit 1
fi

if [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  echo "Error: AWS_SECRET_ACCESS_KEY not set"
  exit 1
fi

if [ -z "$AWS_REGION" ]; then
  echo "Error: AWS_REGION not set"
  exit 1
fi

if [ -z "$S3_BUCKET_NAME" ]; then
  echo "Error: S3_BUCKET_NAME not set"
  exit 1
fi

npm run start
