import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { searchProfiles } from './search.js';
import { parseJobDescription, rankAll, suggestVariants, modelsFromEnv } from './ai.js';
import { findMatches } from './match.js';
import { fetchPhoto } from './photo.js';
import { basicAuthOk, createRateLimiter, clientKey } from './guard.js';

// Local runs read .env; on a host (Docker, Render, pm2) the platform provides the variables instead.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const { SERPER_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, APP_PASSWORD, ALLOW_OPEN, TRUST_PROXY, NODE_ENV, PORT = 4100 } = process.env;
if (!SERPER_API_KEY) {
  console.error('Set SERPER_API_KEY (get one at https://serper.dev)');
  process.exit(1);
}
// Fail closed: a production deployment without a password would let anyone spend your search and AI credits.
if (NODE_ENV === 'production' && !APP_PASSWORD && ALLOW_OPEN !== 'true') {
  console.error('Refusing to start in production without APP_PASSWORD. Set it (recommended), or ALLOW_OPEN=true to run unprotected.');
  process.exit(1);
}
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const num = (v) => (v === null || v === '' ? null : Number.isFinite(+v) ? +v : null);
const readJson = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
};
const aiKeys = { anthropicKey: ANTHROPIC_API_KEY, geminiKey: GEMINI_API_KEY, models: modelsFromEnv(process.env) };
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const limited = createRateLimiter({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PER_MIN) || 120 });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams;
    try {
      // Health check for the host / load balancer: no secrets, no login.
      if (url.pathname === '/health') return send(res, 200, { status: 'ok' });

      if (!basicAuthOk(req.headers.authorization, APP_PASSWORD)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TalentHunt", charset="UTF-8"', 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        return res.end('Password required');
      }
      if (url.pathname.startsWith('/api/') && limited(clientKey(req, TRUST_PROXY === 'true'))) {
        res.setHeader('Retry-After', '60');
        return send(res, 429, { error: 'Too many requests. Please wait a minute and try again.' });
      }

      if (url.pathname === '/api/search') {
        const data = await searchProfiles(
          {
            role: p.get('role')?.trim(),
            minExp: num(p.get('minExp')),
            maxExp: num(p.get('maxExp')),
            location: p.get('location')?.trim(),
            visa: p.get('visa')?.trim(),
            extra: p.get('extra')?.trim(),
            source: p.get('source') || 'all',
            limit: p.get('limit'),
          },
          { apiKey: SERPER_API_KEY },
        );
        return send(res, 200, data);
      }
      if (url.pathname === '/api/photo') {
        // Costs one search credit unless the profile was fetched before (then cached: true).
        return send(res, 200, await fetchPhoto(p.get('link') || '', { apiKey: SERPER_API_KEY }));
      }
      if (url.pathname === '/api/parse-jd' && req.method === 'POST') {
        const { text } = await readJson(req);
        return send(res, 200, await parseJobDescription(text, aiKeys));
      }
      if (url.pathname === '/api/match' && req.method === 'POST') {
        const b = await readJson(req);
        const fields = {
          role: b.role?.trim(),
          minExp: num(b.minExp ?? null),
          maxExp: num(b.maxExp ?? null),
          location: b.location?.trim(),
          visa: b.visa?.trim(),
          extra: b.extra?.trim(),
          source: b.source || 'all',
        };
        // A search can research for minutes, so stream newline-delimited JSON: progress lines,
        // then one final {type:'result'} or {type:'error'}. X-Accel-Buffering tells nginx not to hold it back.
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
        const line = (obj) => res.write(JSON.stringify(obj) + '\n');
        try {
          const result = await findMatches(
            {
              ...fields,
              limit: b.limit,
              minScore: b.minScore,
              jd: b.jd,
              mode: b.mode,
              state: b.state,
              exclude: b.exclude,
              need: num(b.need ?? null),
            },
            {
              search: (sp) => searchProfiles(sp, { apiKey: SERPER_API_KEY }),
              rank: (jd, cands) => rankAll(jd, cands, aiKeys),
              variants: (brief, tried) => suggestVariants(brief, tried, aiKeys),
            },
            (p) => line({ type: 'progress', ...p }),
          );
          line({ type: 'result', ...result });
        } catch (err) {
          line({ type: 'error', error: err.message });
        }
        return res.end();
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, await readFile(path.join(publicDir, 'index.html')), 'text/html; charset=utf-8');
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      send(res, err.status || 500, { error: err.message });
    }
  })
  .listen(PORT, () => console.log(`TalentHunt on http://localhost:${PORT}${APP_PASSWORD ? ' (password protected)' : ''}`));
