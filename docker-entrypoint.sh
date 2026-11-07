#!/bin/sh
# Make the data volume writable for the unprivileged app user (host folders are often root-owned),
# then drop privileges and start the app.
set -e
mkdir -p /data
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
