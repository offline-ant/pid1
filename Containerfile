FROM docker.io/library/node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY Makefile tsconfig.json ./
COPY native ./native
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM docker.io/library/node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /state
WORKDIR /workspace
COPY --from=build /app/build/pid1 /app/build/pid1
COPY --from=build /app/dist /app/dist
COPY --from=build /app/src/system.md /app/src/system.md
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
ENV PID1_STATE_DIR=/state
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/build/pid1", "--", "node", "/app/dist/main.js"]
