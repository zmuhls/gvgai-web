FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js restore.js ./
COPY lib ./lib

ENV NODE_ENV=production
USER node
CMD ["node", "index.js"]
