#!/usr/bin/with-contenv bashio
set -e

export APP_PASSWORD="$(bashio::config 'password')"
export API_KEY="$(bashio::config 'api_key')"
export SESSION_DAYS="$(bashio::config 'session_days')"
export DB_PATH="/config/snippet.db"
export HOST="0.0.0.0"
export PORT="8099"

exec node /app/src/server.js
