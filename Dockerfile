# syntax=docker/dockerfile:1

# ---- Build stage: compile the static dashboard with Bun ----------------------
FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app

# Install dependencies first (cached until the lockfile changes).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build the production bundle.
COPY . .
# Optional: bake a default bunqueue server origin into the build. Leave unset to
# configure it at runtime from the dashboard's Settings page.
ARG VITE_BUNQUEUE_URL=""
ENV VITE_BUNQUEUE_URL=$VITE_BUNQUEUE_URL
RUN bun run build

# ---- Serve stage: nginx serving the static SPA -------------------------------
FROM nginx:1.27-alpine AS runtime
LABEL org.opencontainers.image.title="bunqueue-dashboard" \
      org.opencontainers.image.description="Web dashboard for a bunqueue server" \
      org.opencontainers.image.source="https://github.com/egeominotti/bunqueue-dashboard"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
