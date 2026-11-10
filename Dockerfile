# AttendSecure runs as one Node service: static frontend + JSON API + SQLite database.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

# Install production dependencies first so this layer is cached between builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# The database and captured photos live on the mounted volume, never in the image.
RUN mkdir -p /data/data /data/private_uploads/photos
VOLUME ["/data"]

EXPOSE 8080

# Seed creates the first lecturer account and default courses only when missing.
CMD ["sh", "-c", "node scripts/seed.js && node server/server.js"]
