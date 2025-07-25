# Use Node.js 18 LTS as base image
FROM node:18-bullseye

# Install FFmpeg and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installation
RUN ffmpeg -version && ffprobe -version

# Create app directory
WORKDIR /app

# Create directories for temp files and tokens
RUN mkdir -p /app/temp /app/config

# Copy package files first (for better caching)
COPY package*.json ./

# Install pm2
RUN npm i -g pm2

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV TOKEN_FILE=/app/.worker-tokens.json

# Default command - but this can be overridden
CMD ["./start.sh"]