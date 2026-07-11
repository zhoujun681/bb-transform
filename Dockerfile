FROM node:22-alpine

# coturn = TURN relay (for peers behind mDNS/AP-isolation on phones);
# supervisor = run coturn + node together in one container.
RUN apk add --no-cache coturn supervisor

WORKDIR /app

# Install server deps first (better layer caching)
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# Copy the server, the static app, and the coturn + supervisor configs.
COPY server ./server
COPY index.html styles.css app.js ./
COPY core ./core
COPY vendor ./vendor

ENV PORT=8080
# TURN signaling port (TCP+UDP) and the relay UDP range MUST match what's
# published in docker-compose.yml and server/turnserver.conf.
ENV TURN_PORT=3478
EXPOSE 8080 3478

# Supervisord runs coturn + the node server, restarts either on crash.
CMD ["supervisord", "-c", "/app/server/supervisord.conf"]
