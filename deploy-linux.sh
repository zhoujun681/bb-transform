#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
SERVER_IP=${SERVER_IP:-localhost}
HOST_NAME=$(hostname 2>/dev/null || echo bb-transform-linux)

if [ ! -s _cert.pem ] || [ ! -s _key.pem ]; then
  echo "Missing _cert.pem or _key.pem. Rebuild the deployment directory first." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to verify or refresh the HTTPS certificate." >&2
  exit 1
fi

if ! openssl x509 -in _cert.pem -noout -ext subjectAltName 2>/dev/null |
    grep -Fq "IP Address:${SERVER_IP}"; then
  echo "Refreshing the self-signed certificate for ${SERVER_IP}..."
  if ! openssl req -x509 -newkey rsa:2048 \
      -keyout _key.pem -out _cert.pem -days 365 -nodes \
      -subj "/CN=bb-transform-local" \
      -addext "subjectAltName=DNS:localhost,DNS:${HOST_NAME},IP:127.0.0.1,IP:${SERVER_IP}" \
      >/dev/null 2>&1; then
    echo "Failed to generate the HTTPS certificate." >&2
    exit 1
  fi
fi

chmod 600 _key.pem
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d --build
else
  echo "Docker Compose is unavailable. Install the compose plugin or docker-compose." >&2
  exit 1
fi

echo
echo "bb-transform is running:"
echo "  HTTP:  http://${SERVER_IP}:8081"
echo "  HTTPS: https://${SERVER_IP}:8443"
echo "  TURN:  ${SERVER_IP}:3478"
echo
echo "The bundled certificate is self-signed. Trust _cert.pem on each client device."
