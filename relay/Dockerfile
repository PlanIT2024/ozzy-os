FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js wire.js ./
ENV NODE_ENV=production RELAY_BIND=0.0.0.0
USER node
CMD ["node", "index.js"]
