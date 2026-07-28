FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY src/web/public/ ./public/

EXPOSE 3007

CMD ["node", "dist/index.js"]
