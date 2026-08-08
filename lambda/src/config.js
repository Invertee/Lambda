import fs from 'node:fs';
import path from 'node:path';

function readHomeAssistantOptions() {
  const optionsPath = process.env.OPTIONS_PATH || '/data/options.json';
  try {
    return JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
  } catch {
    return {};
  }
}

function booleanFrom(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function loadConfig() {
  const options = readHomeAssistantOptions();
  const configuredApiKey = process.env.API_KEY || options.api_key;
  const homeAssistantStorage = process.platform !== 'win32' && fs.existsSync('/config');
  const dbPath = process.env.DB_PATH
    || options.storage_path
    || (homeAssistantStorage ? '/config/snippet.db' : path.resolve('data', 'snippet.db'));

  return {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || options.port || 8099),
    password: String(process.env.APP_PASSWORD || options.password || 'changeme'),
    apiKey: configuredApiKey && configuredApiKey !== 'null' ? String(configuredApiKey) : '',
    dbPath,
    attachmentDir: process.env.ATTACHMENTS_PATH
      || options.attachments_path
      || path.join(path.dirname(dbPath), 'attachments'),
    cookieSecure: booleanFrom(process.env.COOKIE_SECURE, false),
    sessionDays: Math.max(1, Number(process.env.SESSION_DAYS || options.session_days || 30)),
  };
}
