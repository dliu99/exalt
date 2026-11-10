# Exalt's server for a container host (Render: render.yaml). Only the server and the one app
# module it reads (app.ts, for the API address) go in; the app itself is a static site.
FROM litestream/litestream:0.3.13 AS litestream
FROM oven/bun:1.4.4-slim
# ffmpeg compresses each narrated chapter to AAC in M4A before it is stored (server/encode.ts);
# Litestream keeps the SQLite database copied to the audio bucket (deploy/start.sh), and needs
# the system's certificates to reach it.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
WORKDIR /app
COPY server/package.json server/bun.lock server/
RUN cd server && bun install --frozen-lockfile --production
COPY app.ts ./
COPY server/ server/
COPY deploy/litestream.yml /app/litestream.yml
COPY deploy/start.sh /app/start.sh
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000
EXPOSE 10000
CMD ["sh", "/app/start.sh"]
