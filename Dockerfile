# Exalt's server for a container host (Render: render.yaml). Only the server and the one app
# module it reads (app.ts, for the API address) go in; the app itself is a static site.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY server/package.json server/bun.lock server/
RUN cd server && bun install --frozen-lockfile --production
COPY app.ts ./
COPY server/ server/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000
EXPOSE 10000
CMD ["bun", "server/index.ts"]
