# Multi-arch OCI index digest for node:24-bookworm-slim, recorded 2026-09-06.
# Resolves linux/amd64 for release builds and linux/arm64 for local builds.
# Used only for building: npm, a shell and a compiler live here, not in the
# image that ships.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
# Multi-arch OCI index digest for gcr.io/distroless/nodejs24-debian12,
# recorded 2026-09-06. The runtime carries ten Debian packages and none of
# perl, pcre2, util-linux or zlib, so the package families the registry scan
# reported are absent rather than excused.
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian12@sha256:61f4f4341db81820c24ce771b83d202eb6452076f58628cd536cc7d94a10978b

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

# The runtime has no shell, so the writable paths are shaped here and copied
# with their ownership and mode intact. The pinned official Node build is
# staged here too: the distroless base bundles 24.14.0, which predates the
# June 2026 security releases, and this base carries 24.20.0.
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
