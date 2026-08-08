FROM ghcr.io/home-assistant/base:3.22

ARG BUILD_VERSION=1.0.0
ARG BUILD_ARCH

LABEL \
  io.hass.name="Lambda" \
  io.hass.description="Private notes and script snippets" \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

RUN apk add --no-cache nodejs

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 8099
CMD ["/run.sh"]
