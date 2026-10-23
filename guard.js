// Access protection for a publicly reachable deployment: optional shared-password (HTTP Basic) and a
// small per-client rate limit. Every search spends paid API credits, so an open URL would let anyone drain them.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(String(s)).digest();

// true when no password is configured, or the Authorization header carries the right password
// (the user name is ignored). Comparing fixed-length hashes keeps the check constant-time.
export function basicAuthOk(header, password) {
  if (!password) return true;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(header || ''));
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(digest(given), digest(password));
}

// Fixed-window counter per key. Returns a function: limited(key) -> true when the key is over the limit.
export function createRateLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
    const cur = hits.get(key);
    if (!cur || now - cur.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return false;
    }
    cur.count++;
    return cur.count > max;
  };
}

// Client address: behind a reverse proxy (Render, nginx) the real one is the first X-Forwarded-For entry.
export function clientKey(req, trustProxy) {
  const fwd = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || req.socket.remoteAddress || 'unknown';
}
