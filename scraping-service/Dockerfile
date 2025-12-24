FROM node:20-slim

# Set production environment to avoid installing dev dependencies
ENV NODE_ENV=production

# Install Chromium dependencies and build tools for native modules
# Security: Use --no-install-recommends to avoid installing unnecessary packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    g++ \
    gnupg \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    make \
    python3 \
    wget \
    xdg-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (re2 requires build tools for native compilation)
# Security: Use --ignore-scripts to prevent execution of package lifecycle scripts
# Note: Native module compilation (node-gyp) still runs, only package.json scripts are ignored
RUN npm ci --only=production --ignore-scripts \
    && npm rebuild \
    && apt-get purge -y --auto-remove python3 make g++

# Change ownership to node user before installing Chrome
RUN chown -R node:node /app

# Switch to non-root user BEFORE installing Chrome
USER node

# Install Chrome as node user (will install to /home/node/.cache/puppeteer)
# This layer will be cached as long as package.json doesn't change
# CRITICAL: This must happen BEFORE copying application code
RUN npx puppeteer browsers install chrome

# Copy application files (changing these won't invalidate Chrome installation cache)
COPY --chown=node:node index.js .
COPY --chown=node:node routes/ ./routes/
COPY --chown=node:node utils/ ./utils/
COPY --chown=node:node config/ ./config/

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
