# Relayer Server Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy server code
COPY server.js ./

# Environment variables (override at runtime)
ENV PORT=3002

EXPOSE 3002

CMD ["node", "server.js"]
