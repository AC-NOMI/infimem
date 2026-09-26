# --- build stage: full dev deps + tsc ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: prod deps only ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY LICENSE README.md ./
ENV INFIMEM_DB=/data/memory.db
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/cli/index.js", "serve", "--host", "0.0.0.0", "--port", "8787"]
