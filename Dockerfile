FROM node:20-slim

# Install dependencies for Puppeteer/Chrome, FFmpeg, and Python3 (for yt-dlp)
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    ffmpeg \
    python3 \
    python3-pip \
    dumb-init \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp globally via pip (more up-to-date than apt)
RUN pip3 install --break-system-packages yt-dlp

# Configure yt-dlp to use android player client (more reliable, avoids SABR streaming issues)
RUN mkdir -p /root/.config/yt-dlp && \
    echo '--extractor-args "youtube:player_client=android"' > /root/.config/yt-dlp/config

# Install Google Chrome (amd64) or Chromium (arm64)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update && \
    apt-get install -y google-chrome-stable --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*; \
    else \
    apt-get update && \
    apt-get install -y chromium --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    ln -sf /usr/bin/chromium /usr/bin/google-chrome-stable; \
    fi

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy application code
COPY . .

# Create directories for data (including .wwebjs_auth for RemoteAuth)
RUN mkdir -p /app/temp /app/whatsapp-session /app/.wwebjs_auth

# Set environment variables for Puppeteer and yt-dlp
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV CHROME_CRASHPAD_HANDLER_DISABLED=1
ENV PATH="/usr/local/bin:$PATH"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]