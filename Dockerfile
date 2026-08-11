FROM node:22-alpine

# The image contains both the signaling server and coturn. Override
# ALPINE_MIRROR at build time if the default regional mirror is unavailable.
ARG ALPINE_MIRROR=mirrors.aliyun.com
RUN sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories \
  && apk add --no-cache coturn supervisor

WORKDIR /app

# Install server deps first (better layer caching)
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# Copy the server and static app.
COPY server ./server
COPY index.html styles.css app.js ./
COPY core ./core
COPY vendor ./vendor

ENV PORT=8081
EXPOSE 8081 3478

# Supervisord keeps coturn and the Node signaling server in the same image.
CMD ["supervisord", "-c", "/app/server/supervisord.conf"]
