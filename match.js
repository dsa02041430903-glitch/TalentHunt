// Orchestrates recruiter searches in two steps, so the first answer is fast and extra effort is opt-in:
//   mode 'first' – the user's own query (relaxed as needed) over a pool wider than N; score it; stop.
//   mode 'more'  – research: AI-suggested alternative titles / skill pairings, screening only people
//                  not seen before, until `need` more qualify or this click's budget is spent.
// The server is stateless, so what's been seen/tried travels in `state` and comes back updated.
// Search, ranking and variant suggestion are injected so this stays testable without network calls.
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export const DEFAULT_MIN_SCORE = 75;
const ROUNDS_PER_MORE = 2; // research rounds per "Search more" click
const VARIANTS_PER_ROUND = 2;
const VARIANT_POOL = 40; // results pulled per alternative search
const MAX_SCREENED_PER_RUN = 150; // cap on how many people one click will score

// Used as the ranking brief when no job description was pasted.
export function describeFields(f) {
  return [
    f.role,
    f.minExp != null && `${f.minExp}-${f.maxExp ?? '+'} years experience`,
    f.location && `in ${f.location}`,
    f.visa && `work authorization ${f.visa}`,
    f.extra,
  ]
    .filter(Boolean)
    .join(', ');
}

// The same person often shows up several times (regional LinkedIn domains, re-created profiles,
// spelling variants). Key on the profile path, then on name + headline with punctuation/spacing removed.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const profileKey = (r) => {
  try {
    const u = new URL(r.link);
    return u.hostname.endsWith('linkedin.com') ? 'li:' + u.pathname.replace(/\/+$/, '').toLowerCase() : u.hostname + u.pathname;
  } catch {
    return r.link;
  }
};
export const keysOf = (r) => [profileKey(r), r.name && 'nh:' + norm(r.name) + norm(r.headline).slice(0, 30)].filter(Boolean);

// Drops repeats within `results`, and anything already in `seen` (mutated to include the survivors).
export function dedupe(results, seen = new Set()) {
  return results.filter((r) => {
    const keys = keysOf(r);
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}

// `state` comes from the client, so keep only well-formed, bounded values.
const strings = (a, max) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.length < 400).slice(0, max) : []);
const variantList = (a) =>
  (Array.isArray(a) ? a : [])
    .filter((v) => v && typeof v.role === 'string')
    .slice(0, 40)
    .map((v) => ({ role: v.role.slice(0, 80), keywords: strings(v.keywords, 3) }));

// Already-scored qualifying people held back from an earlier response (state.banked), re-validated.
const bankList = (a) =>
  (Array.isArray(a) ? a : [])
    .filter((r) => r && typeof r.link === 'string' && typeof r.name === 'string' && Number.isFinite(r.score))
    .slice(0, 300)
    .map((r) => ({
      name: r.name.slice(0, 200),
      headline: String(r.headline || '').slice(0, 300),
      snippet: String(r.snippet || '').slice(0, 600),
      link: r.link.slice(0, 500),
      source: String(r.source || '').slice(0, 100),
      image: typeof r.image === 'string' ? r.image.slice(0, 500) : null,
      score: r.score,
      reason: String(r.reason || '').slice(0, 300),
      keys: strings(r.keys, 4),
      ...(Array.isArray(r.relaxed) ? { relaxed: strings(r.relaxed, 6) } : {}),
    }));

export async function findMatches(input, { search, rank, variants = async () => [] }, onProgress = () => {}) {
  const n = clamp(parseInt(input.limit, 10) || 15, 1, 100);
  const parsedMin = Number(input.minScore);
  const minScore = clamp(input.minScore == null || Number.isNaN(parsedMin) ? DEFAULT_MIN_SCORE : parsedMin, 0, 100);
  const brief = input.jd?.trim() || describeFields(input);
  const mode = input.mode === 'more' ? 'more' : 'first';
  const need = mode === 'more' ? clamp(parseInt(input.need, 10) || n, 1, n) : n;
  // Many results won't clear the bar, so the first pass screens several times more than N.
  const pool = Math.min(100, Math.max(30, n * 4));

  const st = input.state || {};
  // `exclude` = people the recruiter permanently removed (as dedupe keys): never fetched into scoring again.
  const seen = new Set([...strings(st.seen, 6000), ...strings(input.exclude, 6000)]);
  const tried = variantList(st.tried);
  if (!tried.length) tried.push({ role: input.role || '', keywords: input.extra ? [input.extra] : [] });
  const queue = variantList(st.pending);

  // In 'more' mode, start from people an earlier run already scored but didn't hand out.
  const qualified = mode === 'more' ? bankList(st.banked) : [];
  let screened = 0;
  let searches = 0;
  let duplicatesRemoved = 0;
  let query;
  let relaxed = [];
  let exhausted = false;

  const progress = (text) => onProgress({ text, found: Math.min(qualified.length, need), requested: need, screened, searches });
  const stats = () => ({ mode, query, relaxed, minScore, requested: n, need, screened, searches, duplicatesRemoved });
  let banked = [];
  const state = () => ({ seen: [...seen], tried, pending: queue, banked });

  // Score a batch of fresh candidates and bank the ones at/above the threshold. If ranking is
  // unavailable the batch is un-marked as seen (so a later click can try it again) and the error rethrown.
  async function screen(raw) {
    const before = new Set(seen);
    const fresh = dedupe(raw, seen);
    duplicatesRemoved += raw.length - fresh.length;
    if (!fresh.length) return;
    progress(`Scoring ${fresh.length} new profiles against the job…`);
    let order;
    try {
      order = await rank(brief, fresh);
    } catch (err) {
      seen.clear();
      before.forEach((k) => seen.add(k));
      throw err;
    }
    screened += fresh.length;
    for (const o of order) {
      if (o.score != null && o.score >= minScore) qualified.push({ ...fresh[o.index], keys: keysOf(fresh[o.index]), score: o.score, reason: o.reason });
    }
  }

  if (mode === 'first') {
    progress('Searching…');
    const first = await search({ ...input, limit: pool });
    searches++;
    query = first.query;
    relaxed = first.relaxed;
    if (!first.count) return { ...stats(), count: 0, results: [], state: state(), exhausted };
    try {
      await screen(first.results);
    } catch (err) {
      // Without scores the threshold can't be applied — return the plain search order and say so.
      const plain = dedupe(first.results).slice(0, n).map((r) => ({ ...r, keys: keysOf(r) }));
      return { ...stats(), unranked: true, rankError: err.message, count: plain.length, results: plain, state: state(), exhausted };
    }
  } else {
    // ---- research: alternative searches, new people only
    let rounds = 0;
    while (qualified.length < need && rounds < ROUNDS_PER_MORE && screened < MAX_SCREENED_PER_RUN) {
      if (!queue.length) {
        progress(`Brainstorming other ways to find ${need - qualified.length} more…`);
        try {
          queue.push(...(await variants(brief, tried)));
        } catch {
          /* leave the queue empty */
        }
        if (!queue.length) {
          exhausted = true; // the AI has no new ideas — nothing more to try
          break;
        }
      }
      rounds++;
      const batch = queue.splice(0, VARIANTS_PER_ROUND);
      tried.push(...batch);
      progress(`Searching ${batch.map((v) => `"${v.role}"`).join(' and ')}…`);
      const found = await Promise.all(
        batch.map((v) =>
          search({ ...input, role: v.role, extra: v.keywords.join(' '), limit: VARIANT_POOL, maxRelax: 3 }).catch(() => ({ results: [] })),
        ),
      );
      searches += batch.length;
      try {
        await screen(found.flatMap((f) => f.results));
      } catch (err) {
        if (!qualified.length) throw err; // nothing gained: tell the user ranking is down
        break; // keep what's already banked
      }
      progress(`${Math.min(qualified.length, need)} of ${need} found so far`);
    }
  }

  qualified.sort((a, b) => b.score - a.score);
  // Hand out exactly what was asked for; anything beyond that is already scored, so bank it for the next click.
  const limit = mode === 'first' ? n : need;
  const results = qualified.slice(0, limit);
  banked = qualified.slice(limit);
  return { ...stats(), count: results.length, results, state: state(), exhausted };
}
