FROM node:26-alpine

ENV NODE_ENV=production \
    PORT=8000

WORKDIR /app

# Install only runtime dependencies, exactly as locked
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./

# Numeric UID of the image's `node` user, so runAsNonRoot can verify it
USER 1000:1000
EXPOSE 8000

# Run node directly (not via npm) so it receives SIGTERM from `docker stop`
CMD ["node", "index.js"]
