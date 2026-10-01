# ---------------------------------------------------------------- build stage
#
# The whole verification suite runs inside the image build, not beside it. A
# green local checkout and a red container are the same repository in two
# states, and the one that ships is this one — so `npm run verify` (typecheck,
# every test, then the build) has to pass here or there is no image.
#
FROM node:20-bookworm-slim AS build
WORKDIR /app

ENV NODE_ENV=development
ENV npm_config_update_notifier=false

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The build context has no .git — Coolify and most CI builders send a tree, not
# a repository — so the revision arrives as an argument and is stamped into the
# output. Without this the server reports "unknown" and nobody can tell which
# build is live.
ARG SOURCE_COMMIT=unknown

RUN npm run verify \
 && npm run content:validate \
 && printf '%s\n' "$SOURCE_COMMIT" > dist/COMMIT

# Production dependencies only, resolved from the same lockfile the tests ran
# against. `npm ci --omit=dev` into a clean prefix rather than pruning in place:
# pruning leaves whatever a postinstall script wrote behind.
RUN npm ci --omit=dev --ignore-scripts

# ----------------------------------------------------------- runtime stage
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV SPATIAL_DATA_ROOT=/app/data
ENV SPATIAL_STATIC_ROOT=/app/dist/public
ENV SPATIAL_CONTENT_ROOT=/app/content

# Scientific jobs run in worker threads with their own heap cap; this is the
# parent's ceiling, sized for the default single-run concurrency.
ENV NODE_OPTIONS=--max-old-space-size=1536

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/content ./content
COPY --from=build /app/package.json ./package.json

# The image ships as a non-root user, and the data directory is created and
# owned before the drop so a mounted volume does not arrive unwritable.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 3000

# /healthz reports the content catalogue as well as liveness, so a container
# that boots without its cases fails the check instead of serving an empty lab.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/server/src/index.js"]
