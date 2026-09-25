# Built from the repository root (see railway.json).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
