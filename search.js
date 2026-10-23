// Builds the query and pulls the top-N results from Serper.dev (Google results API).
// Docs: https://serper.dev — POST /search with X-API-KEY, `num` up to 100, `page` for more.
const ENDPOINT = 'https://google.serper.dev/search';
export const MAX_RESULTS = 100;

// Which of the sites you added to the engine to search.
export const SOURCES = {
  all: ['linkedin.com/in', 'kaggle.com'],
  linkedin: ['linkedin.com/in'],
  kaggle: ['kaggle.com'],
};

export function buildQuery({ role, minExp, maxExp, location, visa, extra, source = 'all' }, omit = []) {
  const list = (SOURCES[source] || SOURCES.all).map((s) => `site:${s}`);
  // Parentheses only work around an OR group; Google returns nothing for a lone "(site:x)".
  const parts = [list.length > 1 ? `(${list.join(' OR ')})` : list[0]];
  if (role) parts.push(`"${role}"`);
  if (!omit.includes('experience')) {
    if (minExp != null && maxExp != null) parts.push(`${minExp}-${maxExp} years`);
    else if (minExp != null) parts.push(`${minExp}+ years`);
  }
  if (location && !omit.includes('location')) parts.push(location);
  if (visa && !omit.includes('visa')) parts.push(visa);
  if (extra && !omit.includes('extra')) parts.push(extra);
  return parts.join(' ');
}

export function parseResult(item) {
  const link = item.link || '';
  const host = new URL(link).hostname.replace(/^www\./, '');
  const isLinkedIn = host.endsWith('linkedin.com');
  // LinkedIn titles look like "Name - Headline | LinkedIn"
  const cleaned = (item.title || '').replace(/\s*[|\-–]\s*LinkedIn\s*$/i, '');
  const [name, ...rest] = cleaned.split(/\s+[-–]\s+/);
  return {
    name: isLinkedIn ? name.trim() : item.title || link,
    headline: isLinkedIn ? rest.join(' - ').trim() : '',
    snippet: (item.snippet || '').replace(/\s+/g, ' ').trim(),
    link,
    source: host,
    image: item.imageUrl || null,
  };
}

// Strictest query first, then drop the least important filters until N results are found.
// (Google requires every term, so stacking role + years + visa + location often returns 0.)
const RELAX = [[], ['extra'], ['extra', 'experience'], ['extra', 'experience', 'visa'], ['extra', 'experience', 'visa', 'location']];
const MAX_CALLS = 10;

export async function searchProfiles(params, { apiKey, fetchImpl = fetch }) {
  const n = Math.min(Math.max(parseInt(params.limit, 10) || 10, 1), MAX_RESULTS);
  if (!params.role && !params.extra) {
    throw Object.assign(new Error('Enter at least a role or keyword'), { status: 400 });
  }

  const seen = new Set();
  const results = [];
  const tried = new Set();
  let calls = 0;
  let q;
  let relaxed = [];
  for (const omit of RELAX.slice(0, params.maxRelax ?? RELAX.length)) {
    const query = buildQuery(params, omit);
    if (tried.has(query)) continue; // a dropped filter wasn't set anyway
    tried.add(query);
    q ??= query;
    const before = results.length;
    for (let page = 1; results.length < n && page <= 10 && calls < MAX_CALLS; page++, calls++) {
      // free Serper accounts reject num > 10, so page through 10 at a time
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'us', hl: 'en', num: 10, page }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body.message || `Search provider error ${res.status}`;
        throw Object.assign(new Error(msg), { status: res.status === 429 ? 429 : 502 });
      }
      if (!body.organic?.length) break;
      for (const item of body.organic) {
        if (!item.link || seen.has(item.link)) continue;
        seen.add(item.link);
        results.push({ ...parseResult(item), relaxed: omit });
        if (results.length >= n) break;
      }
    }
    if (results.length > before) relaxed = omit;
    if (results.length >= n || calls >= MAX_CALLS) break;
  }
  return { query: q, count: results.length, relaxed, results };
}
