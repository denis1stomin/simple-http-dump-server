'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createApp, MemoryStore, FileStore } = require('../index.js');

function collect(stream) {
  let data = '';
  stream.on('data', (chunk) => { data += chunk; });
  return () => data;
}

async function withServer(options, fn) {
  const logStream = new PassThrough();
  const log = collect(logStream);
  const dumpStore = options.dumpStore || new MemoryStore();
  const dump = () => (dumpStore.text ? dumpStore.text() : '');
  const server = createApp({ logStream, ...options, dumpStore }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, log, dump });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function parseLines(text) {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
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

test('records requests rejected by the body limit', async () => {
  await withServer({ bodyLimit: '1kb' }, async ({ baseUrl, log, dump }) => {
    const res = await fetch(`${baseUrl}/too/big`, { method: 'POST', body: 'x'.repeat(3072) });
    assert.equal(res.status, 413);
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(log(), / - 413 .*\r?\nPOST \/too\/big HTTP/);
    const record = JSON.parse(dump().trim());
    assert.equal(record.status, 413);
    assert.equal(record.url, '/too/big');
  });
});

test('truncates long bodies in the text log but not in the dump', async () => {
  await withServer({ logBodyLimit: '10b' }, async ({ baseUrl, log, dump }) => {
    await fetch(baseUrl, { method: 'POST', body: 'abcdefghijklmnop' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(log(), /abcdefghij… \(truncated, 16 bytes total\)/);
    assert.equal(JSON.parse(dump().trim()).body, 'abcdefghijklmnop');
  });
});

test('adds a parsed json field for JSON bodies only', async () => {
  await withServer({}, async ({ baseUrl, dump }) => {
    const post = (type, body) => fetch(baseUrl, { method: 'POST', headers: { 'content-type': type }, body });
    await post('application/json; charset=utf-8', '{"a":[1,2]}');
    await post('application/vnd.api+json', '{"b":true}');
    await post('application/json', 'not json');
    await post('text/plain', '{"c":1}');

    const lines = dump().trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.json), [{ a: [1, 2] }, { b: true }, undefined, undefined]);
    assert.equal(lines[2].body, 'not json');
  });
});

test('dump API returns recordings as JSON lines and clears them', async () => {
  await withServer({}, async ({ baseUrl }) => {
    await fetch(`${baseUrl}/a`, { method: 'POST', body: 'one' });
    await fetch(`${baseUrl}/b`);

    let res = await fetch(`${baseUrl}/__dump`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
    // the record is stored before the response, so it is visible right away
    assert.deepEqual(parseLines(await res.text()).map((r) => r.url), ['/a', '/b']);

    res = await fetch(`${baseUrl}/__dump`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    res = await fetch(`${baseUrl}/__dump`);
    assert.equal(await res.text(), '');
  });
});

test('dump API calls are neither recorded nor logged', async () => {
  await withServer({}, async ({ baseUrl, log, dump }) => {
    await fetch(`${baseUrl}/__dump`);
    await fetch(`${baseUrl}/__dump?x=1`, { method: 'DELETE' });
    const res = await fetch(`${baseUrl}/__dump`, { method: 'POST', body: 'x' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, DELETE');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(dump(), '');
    assert.equal(log(), '');
  });
});

test('dump API path is configurable and can be disabled', async () => {
  await withServer({ dumpApiPath: '/_rec' }, async ({ baseUrl }) => {
    await fetch(`${baseUrl}/x`);
    const res = await fetch(`${baseUrl}/_rec`);
    assert.equal(parseLines(await res.text()).length, 1);
  });
  await withServer({ dumpApiPath: '' }, async ({ baseUrl, dump }) => {
    const res = await fetch(`${baseUrl}/__dump`);
    assert.equal(await res.text(), '');
    assert.equal(parseLines(dump())[0].url, '/__dump');
  });
});

test('memory buffer evicts the oldest records past its limit', async () => {
  const dumpStore = new MemoryStore('1kb');
  await withServer({ dumpStore }, async ({ baseUrl }) => {
    for (let i = 0; i < 10; i++) {
      await fetch(`${baseUrl}/r${i}`, { method: 'POST', body: 'x'.repeat(300) });
    }
    const res = await fetch(`${baseUrl}/__dump`);
    const urls = parseLines(await res.text()).map((r) => r.url);
    assert.ok(urls.length > 0 && urls.length < 10);
    assert.equal(urls.at(-1), '/r9');
    assert.equal(Number(res.headers.get('x-dump-dropped')), 10 - urls.length);
  });
});

test('dump API serves and truncates DUMP_FILE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dump-test-'));
  const file = path.join(dir, 'run.jsonl');
  const dumpStore = new FileStore(file);
  try {
    await withServer({ dumpStore }, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/f1`, { method: 'POST', body: 'hello' });
      let res = await fetch(`${baseUrl}/__dump`);
      assert.deepEqual(parseLines(await res.text()).map((r) => r.url), ['/f1']);

      await fetch(`${baseUrl}/__dump`, { method: 'DELETE' });
      assert.equal(fs.readFileSync(file, 'utf8'), '');

      await fetch(`${baseUrl}/f2`);
      res = await fetch(`${baseUrl}/__dump`);
      assert.deepEqual(parseLines(await res.text()).map((r) => r.url), ['/f2']);
    });
  } finally {
    dumpStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
