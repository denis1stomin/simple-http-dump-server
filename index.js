#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const bytes = require('bytes');
const express = require('express');

// Headers that may carry credentials; their values never reach any output.
const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
]);

// Headers written to the JSON lines dump (everything else is dropped).
const DUMP_HEADERS = ['content-type', 'content-length'];

const JSON_CONTENT_TYPE = /^[^;]*[/+]json\s*(;|$)/i;
const NDJSON = 'application/x-ndjson';

function parseBytes(value, name) {
  const result = bytes.parse(value);
  if (result === null || Number.isNaN(result)) throw new Error(`Invalid ${name}: ${value}`);
  return result;
}

/** Keeps the most recent dump lines in memory, evicting the oldest past `limit` bytes. */
class MemoryStore {
  constructor(limit = '64mb') {
    this.limit = parseBytes(limit, 'dump buffer limit');
    this.lines = [];
    this.size = 0;
    this.dropped = 0;
  }

  append(line) {
    this.lines.push(line);
    this.size += Buffer.byteLength(line);
    while (this.size > this.limit && this.lines.length > 0) {
      this.size -= Buffer.byteLength(this.lines.shift());
      this.dropped++;
    }
  }

  text() {
    return this.lines.join('');
  }

  send(res) {
    res.set('X-Dump-Dropped', String(this.dropped)).type(NDJSON).send(this.text());
  }

  clear() {
    this.lines = [];
    this.size = 0;
    this.dropped = 0;
  }
}

/** Appends dump lines to a file, opened up front so a bad path fails at startup. */
class FileStore {
  constructor(path) {
    this.path = path;
    this.fd = fs.openSync(path, 'a');
    this.failed = false;
  }

  append(line) {
    if (this.failed) return;
    try {
      // Synchronous on purpose: the record is on disk before the response is sent
      fs.writeSync(this.fd, line);
    } catch (err) {
      this.failed = true;
      console.error(`simple-http-dump-server: writing DUMP_FILE failed, dump disabled: ${err.message}`);
    }
  }

  send(res) {
    res.type(NDJSON);
    fs.createReadStream(this.path).on('error', () => res.end()).pipe(res);
  }

  clear() {
    fs.ftruncateSync(this.fd, 0);
  }

  close() {
    fs.closeSync(this.fd);
  }
}

function bodyBuffer(req) {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function truncatedBodyText(req, limit) {
  const body = bodyBuffer(req);
  if (body.length <= limit) return body.toString('utf8');
  return `${body.subarray(0, limit).toString('utf8')}… (truncated, ${body.length} bytes total)`;
}

function redactHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = REDACTED_HEADERS.has(name) ? '<redacted>' : value;
  }
  return result;
}

function pickHeaders(headers, names) {
  const result = {};
  for (const name of names) {
    if (headers[name] !== undefined) result[name] = headers[name];
  }
  return result;
}

function dumpRecord(req, status) {
  const body = bodyBuffer(req).toString('utf8');
  const record = {
    ts: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl,
    status,
    headers: pickHeaders(req.headers, DUMP_HEADERS),
    body,
  };
  // Parsed copy of JSON bodies, so consumers don't need to decode `body` again
  if (body && JSON_CONTENT_TYPE.test(req.headers['content-type'] || '')) {
    try {
      record.json = JSON.parse(body);
    } catch {
      // not valid JSON: keep the raw body only
    }
  }
  return record;
}

/**
 * Builds the dump server app.
 * @param {object} [options]
 * @param {string|number} [options.bodyLimit] max accepted body size, e.g. '50mb'
 * @param {string|number} [options.logBodyLimit] max body bytes printed to the text log
 * @param {NodeJS.WritableStream} [options.logStream] human-readable log output
 * @param {MemoryStore|FileStore} [options.dumpStore] where JSON lines records go
 * @param {string} [options.dumpApiPath] path of the dump API; empty string disables it
 */
function createApp({
  bodyLimit = '50mb',
  logBodyLimit = '4kb',
  logStream = process.stdout,
  dumpStore = new MemoryStore(),
  dumpApiPath = '/__dump',
} = {}) {
  const logBodyBytes = parseBytes(logBodyLimit, 'log body limit');

  const app = express();
  app.disable('x-powered-by');

  // Dump API: read or clear the recordings. Its own calls are not recorded or logged.
  if (dumpApiPath) {
    app.all(dumpApiPath, (req, res) => {
      if (req.method === 'GET') return dumpStore.send(res);
      if (req.method === 'DELETE') {
        dumpStore.clear();
        return res.status(204).end();
      }
      res.set('Allow', 'GET, DELETE').status(405).end();
    });
  }

  // Print every request once its response is sent. Registered before the body
  // parser so that rejected requests (e.g. 413) are printed too.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = (Number(process.hrtime.bigint() - started) / 1e6).toFixed(3);
      logStream.write([
        `${new Date().toISOString()} [${req.socket.remoteAddress}] - ${res.statusCode} ${ms} ms`,
        `${req.method} ${req.originalUrl} HTTP/${req.httpVersion}`,
        JSON.stringify(redactHeaders(req.headers)),
        truncatedBodyText(req, logBodyBytes),
        '',
      ].join(os.EOL));
    });
    next();
  });

  // Read every body as raw bytes regardless of its content type
  app.use(express.raw({ type: () => true, limit: bodyLimit }));

  // Answer every request with an empty 200 response. Records are stored before
  // responding, so a client that got its response can fetch the record at once.
  app.use((req, res) => {
    dumpStore.append(JSON.stringify(dumpRecord(req, 200)) + '\n');
    res.status(200).end();
  });

  // Body parser errors (e.g. 413 over BODY_LIMIT): record, reply with the status only
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    dumpStore.append(JSON.stringify(dumpRecord(req, status)) + '\n');
    res.status(status).end();
  });

  return app;
}

function fail(message) {
  console.error(`simple-http-dump-server: ${message}`);
  process.exit(1);
}

function main() {
  const env = process.env;
  const port = Number(env.PORT) || 8000;

  let app;
  let dumpStore;
  try {
    dumpStore = env.DUMP_FILE
      ? new FileStore(env.DUMP_FILE)
      : new MemoryStore(env.DUMP_BUFFER_LIMIT || '64mb');
    app = createApp({
      bodyLimit: env.BODY_LIMIT || '50mb',
      logBodyLimit: env.LOG_BODY_LIMIT || '4kb',
      dumpStore,
      dumpApiPath: env.DUMP_API_PATH ?? '/__dump',
    });
  } catch (err) {
    fail(env.DUMP_FILE && !dumpStore ? `cannot open DUMP_FILE ${env.DUMP_FILE}: ${err.message}` : err.message);
  }

  const server = app.listen(port, () => {
    console.log(`Listening on port ${port} ...`);
  });
  server.on('error', (err) => fail(`cannot listen on port ${port}: ${err.message}`));

  // Stop cleanly on Ctrl+C and `docker stop`
  const shutdown = () => {
    server.close(() => {
      if (dumpStore.close) dumpStore.close();
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { createApp, MemoryStore, FileStore };
