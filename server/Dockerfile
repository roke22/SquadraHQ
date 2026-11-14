# Build from the repository root (it also ships pisha-host, which the server
# hands out to the machines you add):
#   docker build -f server/Dockerfile -t pisha-server .
FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
WORKDIR /app
COPY server ./
COPY host/pisha-host.mjs* ./
COPY install ./install
# Listen on every interface inside the container. The port depends on the mode:
# 7787 for plain HTTP, 443 (+80 for certificates) with --domain / PISHA_DOMAIN.
ENV HOST=0.0.0.0 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 7787 80 443
USER node
CMD ["node", "server.js"]
