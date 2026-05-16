FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /data
ENV DB_PATH=/data/ambio-data.json
ENV SP_CONFIG_PATH=/data/sharepoint-config.json
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
