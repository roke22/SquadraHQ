# Pisha demo: the dashboard and one machine that runs Claude Code, in a
# single container. Everything it keeps (the dashboard's data, the machine's
# credential, Claude Code's login and the projects) lives in one folder.
#
# From deploy/demo (it builds this image):
#   docker-compose up -d
#
# Not for production: there the dashboard and the machines run apart (see the
# README). This is for trying Pisha out on one computer.
FROM node:22-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git ca-certificates procps less \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

WORKDIR /app
COPY server ./
COPY host/pisha-host.mjs* ./
COPY install ./install
# The plugin from this repository, as a local marketplace (not a published
# release), with an id of its contents to reinstall it when the image changes.
COPY .claude-plugin /opt/pisha/.claude-plugin
COPY plugins /opt/pisha/plugins
RUN cd /opt/pisha && find . -type f | sort | xargs sha256sum | sha256sum | cut -c1-16 > /opt/pisha/build-id
COPY deploy/demo/example /opt/pisha-example
COPY deploy/demo/entrypoint.sh deploy/demo/start.sh /usr/local/bin/

# Claude Code is updated by rebuilding the image (it can't update itself here).
ENV PISHA_DIR=/pisha DISABLE_AUTOUPDATER=1
VOLUME /pisha
EXPOSE 7787
ENTRYPOINT ["entrypoint.sh"]
