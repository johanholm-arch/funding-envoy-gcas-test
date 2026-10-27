# FundingEnvoy demo image: the API serves the built web app on one port.
# Build:  docker build -t fundingenvoy .
# Run:    see deploy/azure/GUIDE.md (Azure) or the "Run it in a container" section of the README.
FROM node:22-bookworm-slim

WORKDIR /app
RUN npm install -g pnpm@10.28.0

# Dependencies first, so code changes don't reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @fe/web build

ENV NODE_ENV=demo \
    HOST=0.0.0.0 \
    PORT=8787 \
    FE_TODAY=2027-04-02 \
    FE_UPLOADS=/data/uploads \
    FE_TRUST_PROXY=1
EXPOSE 8787
CMD ["node", "--import", "tsx", "apps/api/src/container-start.ts"]
