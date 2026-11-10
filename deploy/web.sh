#!/bin/sh
# Builds the site against the deployed server and uploads it to Vercel, prebuilt: the build
# needs the exact2 checkout beside this repo, which Vercel's builders don't have.
#   API_BASE_URL=https://api.exaltreader.com sh deploy/web.sh          (a preview)
#   API_BASE_URL=https://api.exaltreader.com sh deploy/web.sh --prod   (production)
set -eu
cd "$(dirname "$0")/.."
: "${API_BASE_URL:?set API_BASE_URL to the server public address, e.g. https://api.exaltreader.com}"
case "$API_BASE_URL" in https://*) ;; *) echo "API_BASE_URL should be https:// (the site is served over https)"; exit 1 ;; esac
rm -rf dist
bun exact.mjs web-build --out dist
cp deploy/vercel.json dist/vercel.json
exec bunx vercel@latest deploy dist "$@"
