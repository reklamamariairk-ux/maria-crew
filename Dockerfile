FROM node:18.20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:18.20-alpine
RUN apk add --no-cache wget tini
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/webapp ./webapp
COPY --from=build /app/admin ./admin
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/openapi.yaml ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
ENTRYPOINT ["tini","--"]
CMD ["node","dist/index.js"]
