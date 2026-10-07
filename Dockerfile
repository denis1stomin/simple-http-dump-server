FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8000

WORKDIR /app

# Install only runtime dependencies, exactly as locked
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./

USER node
EXPOSE 8000

# Run node directly (not via npm) so it receives SIGTERM from `docker stop`
CMD ["node", "index.js"]
