# Multi-architecture indexes keep local arm64 and released amd64 builds pinned.
ARG NODE_IMAGE=node:26.8.2-trixie-slim@sha256:f7bb8247fdb16250dbec7fd0e24f091c6f5f0a29d256f3aef5816a7a369166b2
# The runtime supplies OS libraries without a shell or package manager.
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs26-debian13@sha256:d4883f09086d2c3ccc35d406ef5c9f8c9d06691b72336bc8612cf9a7c2980523

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Empty RELEASE_ID keeps local builds identical; the release pipeline supplies
# one, which bakes deploymentId and the /_assets/<id> prefix (next.config.ts).
ARG RELEASE_ID=""
ENV RELEASE_ID=${RELEASE_ID}
RUN npm run build

# Production dependencies are resolved where npm exists, then copied in.
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Shape writable paths before entering the shell-free runtime, and copy the
# exact builder Node binary so the runtime base cannot choose a different patch.
FROM ${NODE_IMAGE} AS layout
RUN mkdir -p /layout/app/.next/cache /layout/tmp /layout/nodejs/bin \
    && cp /usr/local/bin/node /layout/nodejs/bin/node \
    && cp /usr/local/LICENSE /layout/nodejs/LICENSE \
    && chown -R 1000:1000 /layout/app /layout/tmp \
    && chmod 1777 /layout/tmp

FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
ARG RELEASE_ID=""
ARG SOURCE_REVISION=""
ARG SOURCE_URL=""
# The base sets no PATH entry for node and makes node its entrypoint. Clearing
# the entrypoint and putting node on PATH keeps every existing command form
# working: the task definitions pass ["node", "--experimental-strip-types", …].
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 RELEASE_ID=${RELEASE_ID} \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem \
    PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin
ENTRYPOINT []
LABEL org.opencontainers.image.title="one-door" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.one-door.release-id="${RELEASE_ID}"
# next start re-reads the configuration; without next.config.ts the server
# falls back to defaults and serves chunks from /_next/static while the built
# HTML references /_assets/<release>, so a dynamic page loads two runtimes and
# never hydrates. tsconfig.json is required because Next's SWC transpiler reads
# its compilerOptions to load a TypeScript config.
COPY --chown=1000:1000 package.json package-lock.json next.config.ts tsconfig.json ./
COPY --from=dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/.next ./.next
COPY --chown=1000:1000 src ./src
COPY --chown=1000:1000 scripts ./scripts
COPY --chown=1000:1000 migrations ./migrations
# Public AWS RDS certificate-authority bundle (truststore.pki.rds.amazonaws.com,
# global-bundle.pem). NODE_EXTRA_CA_CERTS extends Node's default roots, so
# provider TLS is unaffected and sslmode=verify-full works on every database
# path: web, worker, migrate, seed, and bootstrap.
COPY --chown=1000:1000 certs ./certs
# A mounted volume defaults to root-owned 0755, which a non-root process
# cannot write; the data plane copies image-path ownership only when a VOLUME
# directive matches the mount's containerPath exactly.
# https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html
# The same copy replaces the base's bundled node and its licence with the
# pinned build, so the shipped binary and the shipped licence match.
COPY --from=layout /layout/ /
VOLUME ["/app/.next/cache", "/tmp"]
# Numeric, because the base has no passwd entry for this identity. Nothing in
# the shipped source calls os.userInfo(), which is what would need one.
USER 1000:1000
EXPOSE 3000
# Direct node argv: signals reach the server process itself, and the 70s
# keep-alive stays above the load balancer's 60s idle timeout so the proxy
# never reuses a connection Node already closed.
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--keepAliveTimeout", "70000"]
