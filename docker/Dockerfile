###############################################################################
# Stage 1: Builder
###############################################################################
FROM node:24.15.0-slim AS builder

WORKDIR /usr/src/microsoft-rewards-bot

ENV PLAYWRIGHT_BROWSERS_PATH=0

# Copy package files
COPY package.json package-lock.json tsconfig.json ./

# Install all dependencies required to build the script
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# Remove build dependencies, and reinstall only runtime dependencies
RUN rm -rf node_modules \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# Install full Chromium binary (not headless-shell) — the bot requires the full browser
RUN npx patchright install --with-deps chromium \
    && rm -rf /root/.cache /tmp/* /var/tmp/*

###############################################################################
# Stage 2: Runtime
###############################################################################
FROM node:24.15.0-slim AS runtime

WORKDIR /usr/src/microsoft-rewards-bot

# Set production environment variables
ENV NODE_ENV=production \
    TZ=UTC \
    PLAYWRIGHT_BROWSERS_PATH=0 \
    FORCE_HEADLESS=1

# Install minimal system libraries required for Chromium headless to run
RUN apt-get update && apt-get install -y --no-install-recommends \
    cron \
    gettext-base \
    tzdata \
    ca-certificates \
    libglib2.0-0 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libasound2 \
    libflac12 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libdav1d6 \
    libx11-6 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libdouble-conversion3 \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Install rimraf globally for runtime build support
RUN npm install -g rimraf

# Copy compiled application and dependencies from builder stage
COPY --from=builder /usr/src/microsoft-rewards-bot/dist ./dist
COPY --from=builder /usr/src/microsoft-rewards-bot/package*.json ./
COPY --from=builder /usr/src/microsoft-rewards-bot/node_modules ./node_modules
COPY --from=builder /usr/src/microsoft-rewards-bot/plugins ./plugins
COPY --from=builder /usr/src/microsoft-rewards-bot/scripts ./scripts

# Core bytecode imports the public bot package by name. Keep the package alias
# available after the production dependency reinstall in the builder stage.
RUN rm -rf ./node_modules/microsoft-rewards-bot \
    && cp -R ./dist ./node_modules/microsoft-rewards-bot

# Copy runtime scripts with proper permissions from the start
COPY --chmod=755 scripts/docker/run_daily.sh ./scripts/docker/run_daily.sh
COPY --chmod=644 src/crontab.template /etc/cron.d/microsoft-rewards-bot.template
COPY --chmod=755 scripts/docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# TODO(review): run as a non-root user. This stage deliberately stays root because
# the entrypoint requires it as PID 1: it reconfigures tzdata, symlinks /etc/localtime,
# writes /etc/cron.d/*, runs `crontab`, and execs `cron -f` (Vixie cron needs root).
# Dropping to a non-root user (e.g. `RUN useradd -r -u 10001 botuser` + chown of the
# app dir and writable sessions/) is not safe without first replacing Vixie cron with a
# user-space scheduler such as supercronic (or relying on the built-in Node scheduler,
# which the entrypoint already prefers when scheduler.enabled=true and CAN run non-root).
# Until then, harden at deploy time instead of in the image, e.g. in compose.yaml:
#   read_only: true
#   tmpfs: [/tmp, /var/run]
#   cap_drop: [ALL]
#   security_opt: ["no-new-privileges:true"]
# (mount sessions/, data/ and logs/ as writable volumes).

# Entrypoint handles TZ, initial run toggle, cron templating & launch
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "echo 'Container started; cron is running.'"]
