# OrangeFile, hosted: one image holding the engine, the web app, PDFium and LibreOffice.
#
#   docker build -t orangefile .
#   docker run --rm -p 8080:8080 -e FILE_API_SESSION_SECRET=$(openssl rand -hex 32) \
#     -e FILE_API_ALLOWED_HOSTS=localhost orangefile
#
# Four stages so that the final image carries no compilers, no node_modules and no sources.

# ---- 1. the web app ----------------------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 2. PDFium, downloaded and checked against the hashes pinned in the script -------------
FROM node:22-bookworm-slim AS pdfium
WORKDIR /src
COPY scripts/get-pdfium.mjs scripts/get-pdfium.mjs
RUN mkdir -p src-tauri/resources/pdfium && node scripts/get-pdfium.mjs

# ---- 3. the engine ----------------------------------------------------------------------------
FROM rust:1-bookworm AS engine
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# The desktop shell is a workspace member; cargo needs its manifest, not its build.
COPY src-tauri/Cargo.toml src-tauri/Cargo.toml
RUN mkdir -p src-tauri/src && echo "" > src-tauri/src/lib.rs
RUN cargo build --release --locked -p file-api --bin file-api

# ---- 4. what runs ---------------------------------------------------------------------------------
FROM debian:bookworm-slim
# LibreOffice does the Word/Excel/PowerPoint conversions. Only the three apps we use, no Java, no GUI extras.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates tini \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      fonts-dejavu-core fonts-liberation2 fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home --home-dir /home/orange --shell /usr/sbin/nologin orange \
 && mkdir -p /data && chown orange:orange /data

WORKDIR /app
COPY --from=engine /src/target/release/file-api /app/file-api
# The engine looks for PDFium in a folder named "pdfium" beside the executable.
COPY --from=pdfium /src/src-tauri/resources/pdfium /app/pdfium
COPY --from=web /src/web/dist /app/web

ENV FILE_API_MODE=hosted \
    FILE_API_BIND=0.0.0.0:8080 \
    FILE_API_DATA_DIR=/data \
    FILE_API_STATIC_DIR=/app/web \
    FILE_API_CLIENT_IP_HEADER=fly-client-ip \
    HOME=/home/orange \
    RUST_LOG=info
# FILE_API_SESSION_SECRET and FILE_API_ALLOWED_HOSTS have no default on purpose: the server refuses to start without them.

USER orange
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/app/file-api"]
