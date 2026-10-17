# ── 1) Compilar la web ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── 2) Relay + web, con ffmpeg ──
FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY relay ./relay
COPY --from=build /app/dist ./dist
ENV RELAY_PORT=8090 DIST_DIR=/app/dist
EXPOSE 8090
USER node
CMD ["node", "relay/server.js"]
