FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy app files
COPY . .

# Create data directory (will be mounted as persistent volume on Fly)
RUN mkdir -p /data

# Use /data for persistent storage (Fly.io volume mount)
ENV DB_PATH=/data/ambio-data.json
ENV SP_CONFIG_PATH=/data/sharepoint-config.json

EXPOSE 3000

CMD ["node", "server.js"]
