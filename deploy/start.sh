#!/bin/sh
# Starts Exalt's server in its container. With an S3/R2 bucket configured (AUDIO_S3_*), Litestream
# first restores the SQLite database from the bucket when this container has none, then runs the
# server and copies every change back to the bucket while it runs (deploy/litestream.yml).
# Without a bucket, the server runs alone and its database lives only on this container's disk.
set -eu
export DB="${DB:-/app/data/data.db}"
mkdir -p "$(dirname "$DB")"
if [ -n "${AUDIO_S3_BUCKET:-}" ] && [ -n "${AUDIO_S3_ACCESS_KEY_ID:-}" ] && [ -n "${AUDIO_S3_SECRET_ACCESS_KEY:-}" ]; then
  export AUDIO_S3_REGION="${AUDIO_S3_REGION:-auto}" AUDIO_S3_ENDPOINT="${AUDIO_S3_ENDPOINT:-}"
  litestream restore -config /app/litestream.yml -if-db-not-exists -if-replica-exists "$DB"
  exec litestream replicate -config /app/litestream.yml -exec "bun server/index.ts"
fi
exec bun server/index.ts
