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

// Headers written to the JSON lines dump file (everything else is dropped).
const DUMP_FILE_HEADERS = ['content-type', 'content-length'];

const JSON_CONTENT_TYPE = /^[^;]*[/+]json\s*(;|$)/i;

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

function dumpRecord(req, res) {
  const body = bodyBuffer(req).toString('utf8');
  const record = {
    ts: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl,
    status: res.statusCode,
    headers: pickHeaders(req.headers, DUMP_FILE_HEADERS),
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
 * @param {NodeJS.WritableStream} [options.dumpStream] optional JSON lines output
 */
function createApp({
  bodyLimit = '50mb',
  logBodyLimit = '4kb',
  logStream = process.stdout,
  dumpStream,
} = {}) {
  const logBodyBytes = bytes.parse(logBodyLimit);
  if (logBodyBytes === null) throw new Error(`Invalid log body limit: ${logBodyLimit}`);

  const app = express();
  app.disable('x-powered-by');

  // Record every request once its response is sent. Registered before the body
  // parser so that rejected requests (e.g. 413) are recorded too.
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

      if (dumpStream && dumpStream.writable) {
        dumpStream.write(JSON.stringify(dumpRecord(req, res)) + '\n');
      }
    });
    next();
  });

  // Read every body as raw bytes regardless of its content type
  app.use(express.raw({ type: () => true, limit: bodyLimit }));

  // Answer every request with an empty 200 response
  app.use((req, res) => {
    res.status(200).end();
  });

  // Body parser errors (e.g. 413 over BODY_LIMIT): reply with the status only
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || 500).end();
  });

  return app;
}

function fail(message) {
  console.error(`simple-http-dump-server: ${message}`);
  process.exit(1);
}

// Opens the dump file up front so a bad path fails at startup, not on the first request
function openDumpStream(path) {
  let fd;
  try {
    fd = fs.openSync(path, 'a');
  } catch (err) {
    fail(`cannot open DUMP_FILE ${path}: ${err.message}`);
  }
  const stream = fs.createWriteStream(path, { fd });
  stream.on('error', (err) => {
    console.error(`simple-http-dump-server: writing DUMP_FILE failed, dump disabled: ${err.message}`);
  });
  return stream;
}

function main() {
  const port = Number(process.env.PORT) || 8000;
  const dumpStream = process.env.DUMP_FILE ? openDumpStream(process.env.DUMP_FILE) : undefined;

  let app;
  try {
    app = createApp({
      bodyLimit: process.env.BODY_LIMIT || '50mb',
      logBodyLimit: process.env.LOG_BODY_LIMIT || '4kb',
      dumpStream,
    });
  } catch (err) {
    fail(err.message);
  }

  const server = app.listen(port, () => {
    console.log(`Listening on port ${port} ...`);
  });
  server.on('error', (err) => fail(`cannot listen on port ${port}: ${err.message}`));

  // Stop cleanly on Ctrl+C and `docker stop`
  const shutdown = () => {
    server.close(() => {
      if (dumpStream) dumpStream.end();
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { createApp };
