import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

export function apiKeyFrom(request) {
  const authorization = String(request.headers.authorization || '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  const apiKeyScheme = authorization.match(/^Api(?:-|\s)?Key\s+(.+)$/i);
  const rawAuthorization = authorization && !authorization.includes(' ') ? authorization : '';
  return String(
    bearer?.[1]
    || apiKeyScheme?.[1]
    || rawAuthorization
    || request.headers['x-api-key']
    || request.headers['api-key']
    || request.headers['x-api_key']
    || '',
  ).trim();
}

export function apiKeyMatches(request, expected) {
  if (!expected) return false;
  const supplied = apiKeyFrom(request);
  return Boolean(supplied) && timingSafeEqual(digest(supplied), digest(expected));
}

function cookiesFrom(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }).filter(([key]) => key));
}

export class AuthManager {
  constructor(password, sessionDays = 30, sessions = new Map()) {
    this.salt = randomBytes(16);
    this.passwordHash = scryptSync(password, this.salt, 64);
    this.sessions = sessions;
    this.sessionMs = sessionDays * 24 * 60 * 60 * 1000;
    this.attempts = new Map();
  }

  passwordMatches(candidate) {
    const hash = scryptSync(String(candidate), this.salt, 64);
    return timingSafeEqual(this.passwordHash, hash);
  }

  clientKey(request) {
    return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
  }

  canAttempt(request) {
    const key = this.clientKey(request);
    const now = Date.now();
    const recent = (this.attempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
    this.attempts.set(key, recent);
    return recent.length < 8;
  }

  recordFailure(request) {
    const key = this.clientKey(request);
    this.attempts.set(key, [...(this.attempts.get(key) || []), Date.now()]);
  }

  clearFailures(request) {
    this.attempts.delete(this.clientKey(request));
  }

  createSession() {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + this.sessionMs);
    return token;
  }

  authenticate(request) {
    const token = cookiesFrom(request).snippet_session;
    const expires = token && this.sessions.get(token);
    if (!expires) return null;
    const now = Date.now();
    if (expires <= now) {
      this.sessions.delete(token);
      return null;
    }
    this.sessions.set(token, now + this.sessionMs);
    return token;
  }

  isAuthenticated(request) {
    return Boolean(this.authenticate(request));
  }

  destroySession(request) {
    const token = cookiesFrom(request).snippet_session;
    if (token) this.sessions.delete(token);
  }

  cookie(token, request, forceSecure = false) {
    const forwardedHttps = String(request.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
    const secure = forceSecure || forwardedHttps || Boolean(request.socket.encrypted);
    return `snippet_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessionMs / 1000)}${secure ? '; Secure' : ''}`;
  }

  expiredCookie(request, forceSecure = false) {
    const forwardedHttps = String(request.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
    const secure = forceSecure || forwardedHttps || Boolean(request.socket.encrypted);
    return `snippet_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}
