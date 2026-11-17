FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY logo.jpeg ./logo.jpeg

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV BASE_DOMAIN=l2sistemas.api.br

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "src/server.js"]
