# Билд TS — на лёгком node-alpine для скорости
FROM node:18.20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY . .
RUN npm run build

# Рантайм: official Playwright base — содержит Chromium + системные библиотеки.
# Версия должна совпадать с playwright из package.json (там сейчас ^1.x).
# При обновлении playwright в package.json — обновить и тег здесь.
FROM mcr.microsoft.com/playwright:v1.60.0-noble
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# tini уже есть в noble через apt; ставим только wget для healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends wget tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/webapp ./webapp
COPY --from=build /app/admin ./admin
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/openapi.yaml ./
# Каталог для сохранённого storageState от 2ГИС (сессия после первого логина).
# В docker-compose.yml монтируется как named volume `gis2-state`.
RUN mkdir -p /data/gis2 && chown -R node:node /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
USER node
ENTRYPOINT ["tini","--"]
CMD ["node","dist/index.js"]
