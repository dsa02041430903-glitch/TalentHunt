import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, searchProfiles } from './search.js';

test('buildQuery combines sites, role, experience, location, visa', () => {
  assert.equal(
    buildQuery({ role: 'Java Developer', minExp: 2, maxExp: 5, location: 'USA', visa: 'H1B' }),
    '(site:linkedin.com/in OR site:kaggle.com) "Java Developer" 2-5 years USA H1B',
  );
});

test('a single source is not wrapped in parentheses', () => {
  assert.match(buildQuery({ role: 'Java', source: 'linkedin' }), /^site:linkedin\.com\/in "Java"/);
});

test('searchProfiles pages until N unique results', async () => {
  const pages = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    pages.push(body.page);
    assert.equal(init.headers['X-API-KEY'], 'k');
    const base = (body.page - 1) * 10;
    const organic = Array.from({ length: 10 }, (_, i) => ({
      title: `Person ${base + i} - Java Dev | LinkedIn`,
      link: `https://www.linkedin.com/in/p${base + i}`,
      snippet: 'x',
    }));
    return { ok: true, json: async () => ({ organic }) };
  };
  const out = await searchProfiles({ role: 'Java', limit: 15 }, { apiKey: 'k', fetchImpl });
  assert.equal(out.count, 15);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(out.results[0].name, 'Person 0');
  assert.equal(out.results[0].headline, 'Java Dev');
});

test('relaxes filters when the strict query is too narrow', async () => {
  const queries = [];
  const fetchImpl = async (url, init) => {
    const { q } = JSON.parse(init.body);
    queries.push(q);
    const organic = q.includes('H1B') ? [] : [{ title: 'A - Dev | LinkedIn', link: 'https://www.linkedin.com/in/a', snippet: '' }];
    return { ok: true, json: async () => ({ organic }) };
  };
  const out = await searchProfiles({ role: 'Java', visa: 'H1B', limit: 1 }, { apiKey: 'k', fetchImpl });
  assert.equal(out.count, 1);
  assert.deepEqual(out.results[0].relaxed, ['extra', 'experience', 'visa']);
  assert.ok(queries[0].includes('H1B') && !queries.at(-1).includes('H1B'));
});

test('provider errors surface with a status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ message: 'Unauthorized' }) });
  await assert.rejects(searchProfiles({ role: 'x' }, { apiKey: 'bad', fetchImpl }), /Unauthorized/);
});

test('empty query is rejected', async () => {
  await assert.rejects(searchProfiles({}, { apiKey: 'k' }), /at least a role/);
});


import { fetchPhoto, profileTarget, _clearPhotoCache } from './photo.js';
import { parseJobDescription, rankCandidates, rankAll, suggestVariants, DEFAULT_MODELS } from './ai.js';

const FIELDS = { role: 'CPQ Business Analyst', minExp: 7, maxExp: 9, location: 'Hyderabad', visa: null, keywords: ['Conga CPQ', 'Salesforce'] };
const jd = 'x'.repeat(50);
const claudeOk = { ok: true, json: async () => ({ content: [{ type: 'tool_use', input: FIELDS }] }) };
const geminiOk = { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(FIELDS) }] } }] }) };

test('parseJobDescription uses Claude when available', async () => {
  const urls = [];
  const out = await parseJobDescription(jd, { anthropicKey: 'a', geminiKey: 'g' }, async (url) => (urls.push(url), claudeOk));
  assert.deepEqual(out, FIELDS);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /anthropic/);
});

test('parseJobDescription falls back to Gemini when Claude fails', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return /anthropic/.test(url) ? { ok: false, status: 500, json: async () => ({ error: { message: 'Server error' } }) } : geminiOk;
  };
  const out = await parseJobDescription(jd, { anthropicKey: 'a', geminiKey: 'g' }, fetchImpl);
  assert.deepEqual(out, FIELDS);
  assert.match(urls[1], /generativelanguage.*gemini-3.5-flash-lite:generateContent/);
});

test('parseJobDescription works with only a Gemini key', async () => {
  const out = await parseJobDescription(jd, { geminiKey: 'g' }, async () => geminiOk);
  assert.equal(out.role, 'CPQ Business Analyst');
});

test('parseJobDescription reports the last error when every provider fails', async () => {
  const fail = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });
  await assert.rejects(parseJobDescription(jd, { anthropicKey: 'a', geminiKey: 'g' }, fail), /quota/);
});

test('parseJobDescription needs a key and real text', async () => {
  await assert.rejects(parseJobDescription(jd, {}), /ANTHROPIC_API_KEY or GEMINI_API_KEY/);
  await assert.rejects(parseJobDescription('hi', { geminiKey: 'g' }), /Paste a job description/);
});

test('rankCandidates sorts by score, clamps, and keeps unscored candidates last', async () => {
  const cands = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  const ranking = [{ index: 1, score: 140, reason: 'strong CPQ' }, { index: 0, score: 40, reason: 'generic BA' }, { index: 9, score: 99, reason: 'bogus' }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { ranking } }] }) });
  const out = await rankCandidates('CPQ Business Analyst', cands, { anthropicKey: 'a' }, fetchImpl);
  assert.deepEqual(out.map((o) => [o.index, o.score]), [[1, 100], [0, 40], [2, null]]);
  assert.equal(out[0].reason, 'strong CPQ');
});

test('rankCandidates falls back to Gemini', async () => {
  const fetchImpl = async (url) =>
    /anthropic/.test(url)
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ranking: [{ index: 1, score: 80, reason: 'r' }, { index: 0, score: 10, reason: 'r' }] }) }] } }] }) };
  const out = await rankCandidates('job text', [{}, {}], { anthropicKey: 'a', geminiKey: 'g' }, fetchImpl);
  assert.deepEqual(out.map((o) => o.index), [1, 0]);
});

test('overloaded providers (503) are retried before giving up', async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls < 2 ? { ok: false, status: 503, json: async () => ({ error: { message: 'busy' } }) } : geminiOk);
  const out = await parseJobDescription(jd, { geminiKey: 'g' }, fetchImpl);
  assert.equal(out.role, 'CPQ Business Analyst');
  assert.equal(calls, 2);
});

test('each task uses its own model, and a failing model falls back to the next in its chain', async () => {
  const models = [];
  const fetchImpl = async (url, init) => {
    const m = /models\/([\w.-]+):/.exec(url)?.[1] ?? JSON.parse(init.body).model;
    models.push(m);
    if (m === DEFAULT_MODELS.rank.gemini[0]) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ranking: [{ index: 0, score: 5, reason: 'r' }, { index: 1, score: 9, reason: 'r' }] }) }] } }] }) };
  };
  await parseJobDescription(jd, { geminiKey: 'g' }, async (u, i) => { models.push(/models\/([\w.-]+):/.exec(u)[1]); return geminiOk; });
  await rankCandidates('job text', [{}, {}], { geminiKey: 'g' }, fetchImpl);
  assert.deepEqual(models, ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
});

test('env overrides replace the first model of a task chain', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body).model); return { ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { ranking: [{ index: 0, score: 1, reason: '' }, { index: 1, score: 2, reason: '' }] } }] }) }; };
  await rankCandidates('job text', [{}, {}], { anthropicKey: 'a', models: { rank: { claude: 'claude-opus-5-5' } } }, fetchImpl);
  assert.deepEqual(seen, ['claude-opus-5-5']);
});

const cands = (n) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i, link: 'https://x/' + i, source: 'linkedin.com' }));
const searchWith = (n) => async (p) => ({ query: 'q', relaxed: [], count: n, results: cands(n), poolAsked: p.limit });

test('rankAll splits a pool into balanced batches and maps indices back', async () => {
  const sizes = [];
  const fetchImpl = async (url, init) => {
    const prompt = JSON.parse(init.body).messages[0].content;
    const n = (prompt.match(/^\d+\. \[/gm) || []).length;
    sizes.push(n);
    const first = prompt.match(/\] (P\d+)/)[1]; // first candidate's name tells us the batch offset
    const offset = Number(first.slice(1));
    const ranking = Array.from({ length: n }, (_, i) => ({ index: i, score: (offset + i) % 100, reason: '' }));
    return { ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { ranking } }] }) };
  };
  const out = await rankAll('job text', cands(45), { anthropicKey: 'a' }, fetchImpl);
  assert.deepEqual(sizes.sort(), [15, 15, 15]);
  assert.equal(out.length, 45);
  assert.deepEqual(new Set(out.map((o) => o.index)).size, 45);
  assert.equal(out[0].score, 44); // P44 -> index 44 mapped back correctly
  assert.equal(out[0].index, 44);
});

test('rankAll throws only if every batch fails; a failed batch is left unscored', async () => {
  const flaky = async (url, init) => {
    // the batch starting at P0 fails on every model in its chain
    if (/] P0 /.test(JSON.parse(init.body).messages[0].content)) return { ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) };
    const n = (JSON.parse(init.body).messages[0].content.match(/^\d+\. \[/gm) || []).length;
    const ranking = Array.from({ length: n }, (_, i) => ({ index: i, score: 80, reason: '' }));
    return { ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { ranking } }] }) };
  };
  const out = await rankAll('job', cands(40), { anthropicKey: 'a' }, flaky);
  assert.equal(out.filter((o) => o.score != null).length, 20);
  assert.equal(out.filter((o) => o.score == null).length, 20);
  const dead = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) });
  await assert.rejects(rankAll('job', cands(40), { anthropicKey: 'a' }, dead), /bad/);
});

test('suggestVariants returns new titles and drops ones already tried', async () => {
  const input = { variants: [{ role: 'Software Engineer', keywords: ['React', 'Node'] }, { role: 'full stack developer', keywords: [] }, { role: '', keywords: [] }] };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', input }] }) });
  const out = await suggestVariants('Full stack job', [{ role: 'Full Stack Developer', keywords: [] }], { anthropicKey: 'a' }, fetchImpl);
  assert.deepEqual(out, [{ role: 'Software Engineer', keywords: ['React', 'Node'] }]);
});

test('profileTarget only accepts https LinkedIn/Kaggle profile links', () => {
  assert.deepEqual(profileTarget('https://in.linkedin.com/in/jane-doe/'), { host: 'linkedin.com', path: '/in/jane-doe' });
  assert.deepEqual(profileTarget('https://www.kaggle.com/janedoe'), { host: 'kaggle.com', path: '/janedoe' });
  assert.equal(profileTarget('http://www.linkedin.com/in/jane'), null); // not https
  assert.equal(profileTarget('https://evil.example.com/in/jane'), null);
  assert.equal(profileTarget('https://notlinkedin.com/in/jane'), null);
  assert.equal(profileTarget('not a url'), null);
  assert.equal(profileTarget('https://www.linkedin.com/'), null);
});

test('fetchPhoto uses the exact profile page, picks the matching image, and caches (no second credit)', async () => {
  _clearPhotoCache();
  let calls = 0, sent;
  const fetchImpl = async (url, init) => {
    calls++; sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ images: [
      { link: 'https://www.linkedin.com/in/someone-else', thumbnailUrl: 'https://t/wrong.jpg' },
      { link: 'https://www.linkedin.com/in/jane-doe/', thumbnailUrl: 'https://t/jane.jpg', title: 'Jane Doe - Dev' },
    ] }) };
  };
  const a = await fetchPhoto('https://www.linkedin.com/in/jane-doe', { apiKey: 'k', fetchImpl });
  assert.equal(sent.q, 'site:linkedin.com/in/jane-doe');
  assert.deepEqual([a.found, a.url, a.cached], [true, 'https://t/jane.jpg', false]);
  const b = await fetchPhoto('https://in.linkedin.com/in/Jane-Doe/', { apiKey: 'k', fetchImpl });
  assert.deepEqual([b.found, b.cached, calls], [true, true, 1]);
});

test('fetchPhoto never attaches another person image, and remembers a miss', async () => {
  _clearPhotoCache();
  let calls = 0;
  const fetchImpl = async () => (calls++, { ok: true, json: async () => ({ images: [{ link: 'https://www.linkedin.com/in/jane-doe-2', thumbnailUrl: 'https://t/x.jpg' }] }) });
  const a = await fetchPhoto('https://www.linkedin.com/in/jane-doe', { apiKey: 'k', fetchImpl });
  assert.deepEqual([a.found, a.url], [false, null]); // "jane-doe-2" must not match "jane-doe"
  await fetchPhoto('https://www.linkedin.com/in/jane-doe', { apiKey: 'k', fetchImpl });
  assert.equal(calls, 1);
});

test('fetchPhoto rejects other hosts and surfaces provider errors', async () => {
  _clearPhotoCache();
  await assert.rejects(fetchPhoto('https://example.com/in/x', { apiKey: 'k' }), /only available for LinkedIn and Kaggle/);
  const bad = async () => ({ ok: false, status: 429, json: async () => ({ message: 'slow down' }) });
  await assert.rejects(fetchPhoto('https://www.linkedin.com/in/someone', { apiKey: 'k', fetchImpl: bad }), /slow down/);
});
