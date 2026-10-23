FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so this layer is cached until package files change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Never run as root. Secrets come from the platform's environment, not from files in the image.
USER node
ENV PORT=4100
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
