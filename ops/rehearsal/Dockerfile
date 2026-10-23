# One-shot runner for scripts/rehearsal/rehearseMigrations.ts inside Railway's
# private network (the production database has no public endpoint).
# PostgreSQL 18 client (pg_dump must be >= the server major), Node 20, gpg, AWS CLI.
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg awscli \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY migrations ./migrations
# No HTTP server, no secrets baked in: everything comes from Railway variables.
CMD ["npx", "tsx", "scripts/rehearsal/rehearseMigrations.ts"]
