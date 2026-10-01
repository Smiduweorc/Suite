FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Every workspace's manifest, or a frozen install refuses the lockfile - but only the
# backend's dependencies are installed (--filter below).
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY api-client/package.json ./api-client/
COPY mobile/package.json ./mobile/
# --production drops devDependencies: vitest, drizzle-kit, the frontend's build chain.
# --filter keeps the other workspaces' dependencies out entirely - without it, Expo and
# React Native would be installed into a server image.
RUN bun install --frozen-lockfile --production --filter '@bevd/backend'

# No bundling step, on purpose: the container runs the same src/ the tests run.
# `bun build` cannot bundle a native addon. @node-rs/argon2 picks its .node binary
# through a runtime platform check, the bundler rewrites those requires relative to the
# original package directory, nothing can load the binary from dist/, and the build
# still exits 0: a green CI shipping an image that dies on the first line.
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bun's isolated linker: packages live in /app/node_modules/.bun, and backend/node_modules
# holds relative symlinks into it. Both halves have to come from the same install.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
# .dockerignore is what keeps node_modules, dist/ and a local .env out of this layer.
COPY backend ./backend
COPY --from=deps /app/backend/node_modules ./backend/node_modules

# CMD is relative to this. proto/ is resolved relative to its own source file.
WORKDIR /app/backend
USER bun
# 3000 is REST + tRPC, 50051 is gRPC.
EXPOSE 3000 50051
CMD ["bun", "run", "src/index.ts"]
