# Exalt's server for a container host (Render: render.yaml). Only the server and the one app
# module it reads (app.ts, for the API address) go in; the app itself is a static site.
FROM oven/bun:1.4.4-slim
# ffmpeg compresses each narrated chapter to AAC in M4A before it is stored (server/encode.ts).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/bun.lock server/
RUN cd server && bun install --frozen-lockfile --production
COPY app.ts ./
COPY server/ server/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000
EXPOSE 10000
CMD ["bun", "server/index.ts"]
