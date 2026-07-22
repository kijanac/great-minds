# syntax=docker/dockerfile:1

FROM node:24-slim AS workspace

ENV CI=true
WORKDIR /workspace

RUN corepack enable
RUN corepack prepare pnpm@11.7.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/goldens/package.json packages/goldens/package.json
COPY packages/server/package.json packages/server/package.json
COPY web/package.json web/package.json

# The workspace's allowBuilds/minimumReleaseAge policy is loaded from
# pnpm-workspace.yaml. Runtime dependencies do not need install scripts.
RUN pnpm install --filter @great-minds/server... --prod --frozen-lockfile --ignore-scripts

COPY packages/database/ packages/database/
COPY packages/domain/ packages/domain/
COPY packages/server/ packages/server/

FROM workspace AS deploy

RUN rm -rf packages/goldens packages/server/test web
RUN rm -rf packages/server/node_modules/@types
RUN rm -f package.json pnpm-lock.yaml pnpm-workspace.yaml packages/*/tsconfig.json

FROM node:24-slim AS runtime

RUN groupadd --system --gid 999 app
RUN useradd --system --gid 999 --uid 999 --create-home app
RUN mkdir -p /data
RUN chown app:app /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app
COPY --from=deploy --chown=app:app /workspace/ ./

USER app

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8787')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "--experimental-strip-types", "packages/server/src/main.ts"]
