# Use official Node.js 18 image
FROM node:18-bullseye

# Install ffmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy rest of the code
COPY . .

# Expose port (Render uses this)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
