#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
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

function bodyText(req) {
  return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
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

/**
 * Builds the dump server app.
 * @param {object} [options]
 * @param {string|number} [options.bodyLimit] max accepted body size, e.g. '50mb'
 * @param {NodeJS.WritableStream} [options.logStream] human-readable log output
 * @param {NodeJS.WritableStream} [options.dumpStream] optional JSON lines output
 */
function createApp({ bodyLimit = '50mb', logStream = process.stdout, dumpStream } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Read every body as raw bytes regardless of its content type
  app.use(express.raw({ type: () => true, limit: bodyLimit }));

  // Print each request as a readable block once its response is sent
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = (Number(process.hrtime.bigint() - started) / 1e6).toFixed(3);
      logStream.write([
        `${new Date().toISOString()} [${req.socket.remoteAddress}] - ${res.statusCode} ${ms} ms`,
        `${req.method} ${req.originalUrl} HTTP/${req.httpVersion}`,
        JSON.stringify(redactHeaders(req.headers)),
        bodyText(req),
        '',
      ].join(os.EOL));
    });
    next();
  });

  // Answer every request with an empty 200 response
  app.use((req, res) => {
    if (dumpStream) {
      const record = {
        ts: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        headers: pickHeaders(req.headers, DUMP_FILE_HEADERS),
        body: bodyText(req),
      };
      dumpStream.write(JSON.stringify(record) + '\n');
    }
    res.status(200).end();
  });

  // Body parser errors (e.g. 413 over BODY_LIMIT): reply with the status only
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || 500).end();
  });

  return app;
}

function main() {
  const port = Number(process.env.PORT) || 8000;
  const dumpStream = process.env.DUMP_FILE
    ? fs.createWriteStream(process.env.DUMP_FILE, { flags: 'a' })
    : undefined;

  const app = createApp({ bodyLimit: process.env.BODY_LIMIT || '50mb', dumpStream });
  const server = app.listen(port, () => {
    console.log(`Listening on port ${port} ...`);
  });

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
