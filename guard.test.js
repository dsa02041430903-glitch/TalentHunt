import test from 'node:test';
import assert from 'node:assert/strict';
import { basicAuthOk, createRateLimiter, clientKey } from './guard.js';

const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

test('no password configured means open access', () => {
  assert.equal(basicAuthOk(undefined, ''), true);
  assert.equal(basicAuthOk('anything', undefined), true);
});

test('the right password passes with any user name, wrong or missing ones fail', () => {
  assert.equal(basicAuthOk(basic('anyone', 's3cret'), 's3cret'), true);
  assert.equal(basicAuthOk(basic('', 's3cret'), 's3cret'), true);
  assert.equal(basicAuthOk(basic('anyone', 'wrong'), 's3cret'), false);
  assert.equal(basicAuthOk(basic('anyone', 's3cre'), 's3cret'), false); // prefix of the real one
  assert.equal(basicAuthOk(undefined, 's3cret'), false);
  assert.equal(basicAuthOk('Bearer abc', 's3cret'), false);
  assert.equal(basicAuthOk('Basic !!!notbase64', 's3cret'), false);
});

test('a password containing a colon still works', () => {
  assert.equal(basicAuthOk(basic('u', 'pa:ss:word'), 'pa:ss:word'), true);
});

test('rate limiter allows max requests per window, then limits, then resets', () => {
  const limited = createRateLimiter({ windowMs: 1000, max: 3 });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => limited('a', 0)), [false, false, false, true, true]);
  assert.equal(limited('b', 0), false); // other clients are unaffected
  assert.equal(limited('a', 1500), false); // new window
});

test('client key uses X-Forwarded-For only when the proxy is trusted', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientKey(req, true), '203.0.113.7');
  assert.equal(clientKey(req, false), '10.0.0.1'); // spoofable header ignored when not behind a proxy
});
