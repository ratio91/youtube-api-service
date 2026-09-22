# syntax=docker/dockerfile:1
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Production stage
# ---------------------------------------------------------------------------
FROM node:24-alpine

# yt-dlp release to bake in. Update by bumping this ARG and rebuilding:
#   docker compose build --build-arg YTDLP_VERSION=2026.xx.yy && docker compose up -d
# Releases: https://github.com/yt-dlp/yt-dlp/releases
ARG YTDLP_VERSION=2026.08.19
# Set automatically by BuildKit (amd64 | arm64).
ARG TARGETARCH

# Install the official standalone yt-dlp binary. The plain `yt-dlp_linux` build
# is glibc-only; Alpine needs the musl build (see docs/verified/2026-09-22-transcript-backends.md A6.1).
# The download is verified against the release's SHA2-256SUMS file and the
# build fails closed if the checksum line is missing.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) asset="yt-dlp_musllinux" ;; \
      arm64) asset="yt-dlp_musllinux_aarch64" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}"; \
    wget -q -O /usr/local/bin/yt-dlp "${base}/${asset}"; \
    wget -q -O /tmp/SHA2-256SUMS "${base}/SHA2-256SUMS"; \
    expected="$(awk -v f="${asset}" '$2 == f { print $1 }' /tmp/SHA2-256SUMS)"; \
    test -n "${expected}" || { echo "no checksum for ${asset} in SHA2-256SUMS" >&2; exit 1; }; \
    echo "${expected}  /usr/local/bin/yt-dlp" | sha256sum -c -; \
    chmod +x /usr/local/bin/yt-dlp; \
    rm -f /tmp/SHA2-256SUMS; \
    /usr/local/bin/yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# /data holds tokens.json (only used when OAuth is configured); /home/node/.cache is
# yt-dlp's cache dir (mounted as a named volume in docker-compose.yml).
RUN mkdir -p /data /home/node/.cache/yt-dlp && chown -R node:node /data /home/node/.cache

USER node

EXPOSE 3000

# Healthcheck via node's built-in fetch (curl/wget not guaranteed in alpine image)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
