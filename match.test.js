import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, dedupe, keysOf } from './match.js';

const person = (id) => ({ name: 'Person ' + id, headline: 'Dev ' + id, link: 'https://www.linkedin.com/in/p' + id, source: 'linkedin.com' });
const ids = (list) => list.map((r) => Number(r.link.match(/p(\d+)$/)[1]));
// people with id % 100 < 2 qualify (score 90); everyone else scores 10
const rank = async (brief, list) => list.map((c, index) => ({ index, score: ids([c])[0] % 100 < 2 ? 90 : 10, reason: 'r' }));
const searchBase = (base, count = 5) => async () => ({ query: 'q', relaxed: [], count, results: Array.from({ length: count }, (_, i) => person(base + i)) });

test('first pass scores one pool, keeps >= threshold best first capped at N, and never researches', async () => {
  let variantCalls = 0;
  const scores = [90, 80, 75, 74, 60, 99];
  const out = await findMatches(
    { role: 'x', limit: 3 },
    {
      search: async () => ({ query: 'q', relaxed: [], count: 6, results: scores.map((_, i) => person(i)) }),
      rank: async (b, list) => list.map((c, index) => ({ index, score: scores[index], reason: 'r' })).sort((a, b) => b.score - a.score),
      variants: async () => (variantCalls++, []),
    },
  );
  assert.deepEqual(out.results.map((r) => r.score), [99, 90, 80]);
  assert.equal(out.mode, 'first');
  assert.equal(variantCalls, 0);
  assert.equal(out.screened, 6);
});

test('first pass screens a pool ~4x N and honours a custom threshold', async () => {
  let asked;
  const search = async (p) => ((asked = p.limit), { query: 'q', relaxed: [], count: 2, results: [person(0), person(1)] });
  const lowRank = async () => [{ index: 0, score: 60, reason: '' }, { index: 1, score: 55, reason: '' }];
  const out = await findMatches({ role: 'x', limit: 15, minScore: 50 }, { search, rank: lowRank });
  assert.equal(asked, 60);
  assert.equal(out.count, 2);
});

test('first pass returns state so "more" can skip everyone already screened', async () => {
  const out = await findMatches({ role: 'Dev', extra: 'React', limit: 5 }, { search: searchBase(0), rank });
  assert.equal(out.count, 2); // p0, p1
  assert.ok(out.state.seen.includes('li:/in/p3')); // screened-but-not-qualified people are remembered too
  assert.deepEqual(out.state.tried, [{ role: 'Dev', keywords: ['React'] }]);
});

test('first pass falls back to search order, flagged, when ranking is unavailable', async () => {
  const out = await findMatches({ role: 'x', limit: 2 }, { search: searchBase(0, 5), rank: async () => { throw new Error('no AI'); } });
  assert.equal(out.unranked, true);
  assert.equal(out.results.length, 2);
  assert.match(out.rankError, /no AI/);
  assert.equal(out.state.seen.length, 0); // nothing was scored, so nothing is marked as seen
});

test('"more" skips the original query, searches AI variants, and returns only new qualifying people', async () => {
  const calls = [];
  const search = async (p) => {
    calls.push(p.role + '|' + (p.extra || ''));
    const base = p.role === 'Software Engineer' ? 100 : 200;
    // p0..p2 of the original search were already seen; the variants return fresh people (plus one repeat)
    return { query: 'q', relaxed: [], count: 3, results: [person(base), person(base + 1), person(0)] };
  };
  const variants = async () => [{ role: 'Software Engineer', keywords: ['React'] }, { role: 'Web Developer', keywords: [] }];
  const state = { seen: [...keysOf(person(0)), ...keysOf(person(1))], tried: [{ role: 'Full Stack Developer', keywords: [] }], pending: [] };
  const out = await findMatches({ role: 'Full Stack Developer', limit: 15, mode: 'more', need: 4, state }, { search, rank, variants });
  assert.equal(out.mode, 'more');
  assert.deepEqual(calls.sort(), ['Software Engineer|React', 'Web Developer|']);
  assert.deepEqual(ids(out.results).sort((a, b) => a - b), [100, 101, 200, 201]); // person(0) was already seen
  assert.equal(out.screened, 4);
  assert.equal(out.exhausted, false);
});

test('"more" stops as soon as enough new people qualify, and keeps unused ideas for the next click', async () => {
  let n = 0;
  const search = async () => ({ query: 'q', relaxed: [], count: 2, results: [person(++n * 100), person(n * 100 + 1)] });
  const variants = async () => Array.from({ length: 8 }, (_, i) => ({ role: 'R' + i, keywords: [] }));
  const out = await findMatches({ role: 'x', limit: 15, mode: 'more', need: 2, state: {} }, { search, rank, variants });
  assert.equal(out.searches, 2); // one round of 2 searches was enough
  assert.equal(out.state.pending.length, 6); // 8 ideas - 2 used
  assert.equal(out.state.tried.length, 3); // original + 2
  assert.equal(out.count, 2); // exactly what was asked for
  assert.equal(out.state.banked.length, 2); // the other 2 qualifiers are kept for later
});

test('"more" caps itself at two research rounds per click', async () => {
  let n = 0;
  const search = async () => ({ query: 'q', relaxed: [], count: 2, results: [person(++n * 100 + 50), person(n * 100 + 51)] }); // nobody qualifies
  const variants = async () => Array.from({ length: 20 }, (_, i) => ({ role: 'R' + i, keywords: [] }));
  const events = [];
  const out = await findMatches({ role: 'x', limit: 15, mode: 'more', need: 5, state: {} }, { search, rank, variants }, (e) => events.push(e));
  assert.equal(out.searches, 4); // 2 rounds x 2 variants
  assert.equal(out.count, 0);
  assert.ok(events.every((e) => e.requested === 5));
});

test('"more" reports exhausted when the AI has no new ideas', async () => {
  const out = await findMatches({ role: 'x', limit: 15, mode: 'more', need: 3, state: {} }, { search: searchBase(0), rank, variants: async () => [] });
  assert.equal(out.exhausted, true);
  assert.equal(out.count, 0);
});

test('"more" tolerates the variants helper throwing', async () => {
  const out = await findMatches({ role: 'x', limit: 15, mode: 'more', need: 3, state: {} }, { search: searchBase(0), rank, variants: async () => { throw new Error('AI down'); } });
  assert.equal(out.exhausted, true);
});

test('"more" does not mark people as seen when ranking fails, so a retry can score them', async () => {
  const state = { seen: [], tried: [], pending: [{ role: 'Alt', keywords: [] }] };
  await assert.rejects(
    findMatches({ role: 'x', limit: 15, mode: 'more', need: 2, state }, { search: searchBase(0), rank: async () => { throw new Error('ranker down'); }, variants: async () => [] }),
    /ranker down/,
  );
});

test('state from the client is sanitised', async () => {
  const state = { seen: ['ok', 5, { x: 1 }, 'a'.repeat(1000)], tried: [{ role: 3 }, { role: 'Fine', keywords: ['k', 7] }, null], pending: 'nope' };
  const out = await findMatches({ role: 'x', limit: 5, mode: 'more', need: 1, state }, { search: searchBase(0), rank, variants: async () => [] });
  assert.deepEqual(out.state.tried, [{ role: 'Fine', keywords: ['k'] }]);
  assert.deepEqual(out.state.seen, ['ok']);
});

test('dedupe merges regional LinkedIn domains and same name+headline variants', () => {
  const rows = [
    { name: 'Srinivasa Gupta K.', headline: 'Salesforce Techno Functional Consultant', link: 'https://www.linkedin.com/in/srini-1' },
    { name: 'Srinivasa Gupta K.', headline: 'Salesforce Techno-Functional Consultant', link: 'https://in.linkedin.com/in/srini-2' },
    { name: 'Someone Else', headline: 'CPQ Analyst', link: 'https://www.linkedin.com/in/other' },
    { name: 'Someone Else', headline: 'CPQ Analyst', link: 'https://in.linkedin.com/in/other/' },
    { name: 'Kaggle User', headline: '', link: 'https://www.kaggle.com/u1' },
  ];
  assert.deepEqual(dedupe(rows).map((r) => r.link), ['https://www.linkedin.com/in/srini-1', 'https://www.linkedin.com/in/other', 'https://www.kaggle.com/u1']);
});

test('"more" serves banked people first and does no searching when they cover the need', async () => {
  let searched = 0;
  const banked = [91, 88, 80].map((s, i) => ({ ...person(900 + i), score: s, reason: 'banked' }));
  const out = await findMatches(
    { role: 'x', limit: 15, mode: 'more', need: 2, state: { banked } },
    { search: async () => (searched++, { results: [] }), rank, variants: async () => [{ role: 'Alt', keywords: [] }] },
  );
  assert.equal(searched, 0);
  assert.deepEqual(out.results.map((r) => r.score), [91, 88]);
  assert.deepEqual(out.state.banked.map((r) => r.score), [80]);
});

test('"more" tops up from the bank, then researches only for the shortfall', async () => {
  const banked = [{ ...person(900), score: 85, reason: 'banked' }];
  const out = await findMatches(
    { role: 'x', limit: 15, mode: 'more', need: 3, state: { banked } },
    { search: searchBase(100, 5), rank, variants: async () => [{ role: 'Alt', keywords: [] }] },
  );
  assert.equal(out.count, 3);
  assert.ok(out.results.some((r) => r.reason === 'banked'));
  assert.ok(out.searches >= 1);
});

test('first pass banks qualifying people beyond N and the bank is sanitised on the way back in', async () => {
  const first = await findMatches({ role: 'x', limit: 1 }, { search: async () => ({ query: 'q', relaxed: [], count: 3, results: [person(0), person(1), person(100)] }), rank: async (b, l) => l.map((c, index) => ({ index, score: 80 + index, reason: '' })) });
  assert.equal(first.count, 1);
  assert.equal(first.state.banked.length, 2);
  const out = await findMatches(
    { role: 'x', limit: 5, mode: 'more', need: 5, state: { banked: [...first.state.banked, { link: 5 }, { link: 'https://x/ok', name: 'N', score: 'high' }] } },
    { search: searchBase(500, 0), rank, variants: async () => [] },
  );
  assert.equal(out.count, 2); // junk entries dropped
});

test('exclude keys (permanently removed people) are never fetched into scoring', async () => {
  const scored = [];
  const out = await findMatches(
    { role: 'x', limit: 5, exclude: keysOf(person(1)) },
    { search: searchBase(0, 4), rank: async (b, list) => (scored.push(...ids(list)), rank(b, list)) },
  );
  assert.deepEqual(scored.sort(), [0, 2, 3]); // person 1 was skipped, so it cost nothing
  assert.ok(!ids(out.results).includes(1));
});

test('results carry their dedupe keys so the client can persist removals', async () => {
  const out = await findMatches({ role: 'x', limit: 5 }, { search: searchBase(0, 2), rank });
  assert.deepEqual(out.results[0].keys, keysOf(person(0)));
});
