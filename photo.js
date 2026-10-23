// Fetches ONE profile photo on demand. Search results carry no photos, so this runs a single
// Serper image search restricted to that exact profile page (1 search credit) and only accepts an
// image whose source page is that profile, so a face is never attached to the wrong person.
const ENDPOINT = 'https://google.serper.dev/images';
const HOSTS = ['linkedin.com', 'kaggle.com'];

// 'https://in.linkedin.com/in/jane-doe/' -> { host: 'linkedin.com', path: '/in/jane-doe' }
export function profileTarget(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const host = HOSTS.find((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  const path = u.pathname.replace(/\/+$/, '');
  if (!host || u.protocol !== 'https:' || path.length < 3) return null;
  return { host, path };
}

// Repeat clicks (or the same person in a later search) must not be charged twice.
const cache = new Map();
const CACHE_MAX = 2000;

export async function fetchPhoto(link, { apiKey, fetchImpl = fetch }) {
  const target = profileTarget(link);
  if (!target) throw Object.assign(new Error('Photos are only available for LinkedIn and Kaggle profile links'), { status: 400 });

  const key = target.host + target.path.toLowerCase();
  if (cache.has(key)) return { ...cache.get(key), cached: true };

  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: `site:${target.host}${target.path}`, gl: 'us', hl: 'en', num: 5 }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body.message || `Photo search error ${res.status}`), { status: res.status === 429 ? 429 : 502 });
  }

  const wanted = target.path.toLowerCase();
  const hit = (body.images || []).find((i) => {
    const page = String(i.link || '').toLowerCase().replace(/\/+$/, '');
    return page.includes(target.host) && page.endsWith(wanted) && (i.thumbnailUrl || i.imageUrl);
  });
  const result = hit
    ? { found: true, url: String(hit.thumbnailUrl || hit.imageUrl), title: String(hit.title || '').slice(0, 120) }
    : { found: false, url: null };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return { ...result, cached: false };
}

export const _clearPhotoCache = () => cache.clear();
