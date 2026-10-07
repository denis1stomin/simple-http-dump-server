'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createApp } = require('../index.js');

function collect(stream) {
  let data = '';
  stream.on('data', (chunk) => { data += chunk; });
  return () => data;
}

async function withServer(options, fn) {
  const logStream = new PassThrough();
  const dumpStream = new PassThrough();
  const log = collect(logStream);
  const dump = collect(dumpStream);
  const server = createApp({ logStream, dumpStream, ...options }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, log, dump });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('answers 200 with an empty body', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/erp/sync/prices`, { method: 'POST', body: '{"a":1}' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });
});

test('accepts bodies above the old 100 KB default', async () => {
  await withServer({}, async ({ baseUrl, dump }) => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ id: i, price: i * 1.5, name: `item-${i}` }));
    const body = JSON.stringify(items);
    assert.ok(body.length > 100 * 1024);

    const res = await fetch(`${baseUrl}/erp/sync/prices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(dump().trim()).body, body);
  });
});

test('rejects bodies above the configured limit', async () => {
  await withServer({ bodyLimit: '1kb' }, async ({ baseUrl }) => {
    const res = await fetch(baseUrl, { method: 'POST', body: 'x'.repeat(2048) });
    assert.equal(res.status, 413);
  });
});

test('writes one JSON line per request without credentials', async () => {
  await withServer({}, async ({ baseUrl, dump }) => {
    await fetch(`${baseUrl}/one?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: 'Bearer test-token' },
      body: 'hello',
    });
    await fetch(`${baseUrl}/two`);

    const lines = dump().trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(
      { method: lines[0].method, url: lines[0].url, body: lines[0].body, headers: lines[0].headers },
      { method: 'POST', url: '/one?x=1', body: 'hello', headers: { 'content-type': 'text/plain', 'content-length': '5' } },
    );
    assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
    assert.equal(lines[1].method, 'GET');
    assert.equal(lines[1].body, '');
  });
});

test('redacts credential headers in the text log', async () => {
  await withServer({}, async ({ baseUrl, log }) => {
    await fetch(baseUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', cookie: 'sid=abc', 'x-trace': 'kept' },
      body: 'payload',
    });
    // the log is written on response finish; give it a tick
    await new Promise((resolve) => setImmediate(resolve));

    const text = log();
    assert.match(text, /POST \/ HTTP\/1\.1/);
    assert.match(text, /"x-trace":"kept"/);
    assert.match(text, /payload/);
    assert.doesNotMatch(text, /test-token|sid=abc/);
  });
});
