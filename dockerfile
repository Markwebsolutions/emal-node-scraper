FROM node:20-slim

# Install Chromium for Puppeteer
RUN apt-get update \
    && apt-get install -y chromium \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer expects chromium path
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install deps
RUN npm install

# Copy rest of project
COPY . .

# Expose server port
EXPOSE 8080

# Start app
CMD ["npm", "start"]
