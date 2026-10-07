# simple-http-dump-server

[![CI](https://github.com/denis1stomin/simple-http-dump-server/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/denis1stomin/simple-http-dump-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/simple-http-dump-server?logo=npm)](https://www.npmjs.com/package/simple-http-dump-server)
[![npm downloads](https://img.shields.io/npm/dm/simple-http-dump-server?logo=npm)](https://www.npmjs.com/package/simple-http-dump-server)
[![Docker image](https://img.shields.io/badge/ghcr.io-simple--http--dump--server-2496ED?logo=docker&logoColor=white)](https://github.com/denis1stomin/simple-http-dump-server/pkgs/container/simple-http-dump-server)
[![Node.js](https://img.shields.io/node/v/simple-http-dump-server?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/github/license/denis1stomin/simple-http-dump-server)](LICENSE)

> A tiny HTTP server that answers **every** request with an empty `200 OK` and shows you exactly what was sent.

Point a webhook, a client under test or a misbehaving integration at it and see the method, path, headers and body of every request. Think of it as a self-hosted RequestBin in a single file with two small dependencies.

```text
$ npx simple-http-dump-server
Listening on port 8000 ...
2026-10-07T08:30:32.274Z [::1] - 200 4.072 ms
POST /webhooks/github HTTP/1.1
{"host":"localhost:8000","user-agent":"GitHub-Hookshot/abc123","authorization":"<redacted>","content-type":"application/json","content-length":"21"}
{"action": "opened"}
```

## ✨ Features

- **Accepts anything.** Any method, any path, any content type. Bodies up to 50 MB by default.
- **Readable output.** One block per request: summary line, request line, headers, then the body (truncated to 4 KB, so the log aggregator doesn't fill up).
- **Machine-readable recordings.** [JSON Lines](https://jsonlines.org) with full bodies and JSON already parsed, ready for `jq`.
- **Dump over HTTP.** `GET /__dump` returns the recordings and `DELETE /__dump` clears them, which suits test suites.
- **Records rejected requests too.** A body over the limit gets `413` and still shows up in the log and the dump.
- **Doesn't leak credentials.** `Authorization`, `Proxy-Authorization`, `Cookie` and `X-Api-Key` are always printed as `<redacted>`.
- **Easy to run.** `npx`, a multi-arch Docker image (amd64/arm64), or a public endpoint on Azure Container Instances.
- **Container-friendly.** Runs as numeric UID 1000 (works with `runAsNonRoot`), fails fast on a bad config, and shuts down cleanly on `docker stop`.

## 🚀 Quick start

**npx** (Node.js 22+):

```sh
npx simple-http-dump-server
```

**Docker:**

```sh
docker run --rm -p 8000:8000 ghcr.io/denis1stomin/simple-http-dump-server
```

> The old Docker Hub image `denis1stomin/simple-http-dump-server` is outdated (2018). Use the `ghcr.io` image above. The Docker Hub copy is updated only if the CI has Docker Hub credentials.

Then send it something:

```sh
curl -X POST http://localhost:8000/some/path \
  -H 'content-type: application/json' \
  -d '{"SomeProp": "value"}'
```

## ⚙️ Configuration

All settings are environment variables.

| Variable            | Default   | Description                                                                 |
|---------------------|-----------|-----------------------------------------------------------------------------|
| `PORT`              | `8000`    | Port to listen on.                                                          |
| `BODY_LIMIT`        | `50mb`    | Max request body size (`100kb`, `10mb`, ...). Larger bodies get a `413`.    |
| `LOG_BODY_LIMIT`    | `4kb`     | Max body bytes printed to stdout; the rest is cut with `… (truncated, N bytes total)`. `0` hides bodies. |
| `DUMP_FILE`         | (unset)   | Store recordings in this file (appended, full bodies). Without it they are kept in memory. |
| `DUMP_BUFFER_LIMIT` | `64mb`    | Size of the in-memory buffer when `DUMP_FILE` isn't set; the oldest records are evicted first. |
| `DUMP_API_PATH`     | `/__dump` | Path of the [dump API](#-reading-the-dump-over-http). Set it to an empty string to turn the API off. |

If `DUMP_FILE` can't be opened (missing directory, read-only filesystem) or a value is invalid, the server exits at startup with a one-line error instead of failing on the first request.

```sh
PORT=9000 BODY_LIMIT=200mb DUMP_FILE=run.jsonl npx simple-http-dump-server
```

## 📄 Recordings (JSON Lines)

Every request is recorded as one JSON object per line, in memory or in `DUMP_FILE`:

```json
{"ts":"2026-10-07T08:30:32.270Z","method":"POST","url":"/some/path","status":200,"headers":{"content-type":"application/json","content-length":"21"},"body":"{\"SomeProp\": \"value\"}","json":{"SomeProp":"value"}}
```

| Field           | Description                                                                                  |
|-----------------|----------------------------------------------------------------------------------------------|
| `ts`            | When the request was answered (ISO 8601).                                                    |
| `method`, `url` | Request method and URL (with query string).                                                  |
| `status`        | Status the server answered with: `200`, or `413` for bodies over `BODY_LIMIT`.               |
| `headers`       | Only `content-type` and `content-length`, so no credentials end up in the recordings.        |
| `body`          | Full body as UTF-8 text (empty for rejected requests).                                       |
| `json`          | Parsed body, present only when the content type is JSON (`application/json`, `*+json`) and the body parses. |

A record is stored **before** the response is sent. Once a client has its response, the record is already available.

## 🔌 Reading the dump over HTTP

The server itself serves the recordings, so tests can fetch them without `kubectl cp` or exec rights on the pod:

| Request          | Response                                                                            |
|------------------|-------------------------------------------------------------------------------------|
| `GET /__dump`    | `200`, all recordings as `application/x-ndjson`. In memory mode, the `X-Dump-Dropped` header says how many old records were evicted. |
| `DELETE /__dump` | `204`, clears the recordings (truncates `DUMP_FILE`, or empties the buffer).        |
| other methods    | `405`                                                                               |

Calls to the dump API are themselves neither recorded nor logged. If the client under test needs the `/__dump` path itself, change `DUMP_API_PATH`.

```sh
curl -s http://localhost:8000/__dump | jq -c 'select(.status != 200) | {ts, url, status}'
curl -s -X DELETE http://localhost:8000/__dump
```

Example pytest fixture:

```python
import json

import pytest
import requests

DUMP = "http://http-dump:8000/__dump"


@pytest.fixture
def recorded():
    requests.delete(DUMP).raise_for_status()      # start every test from a clean dump

    def fetch():
        resp = requests.get(DUMP)
        resp.raise_for_status()
        return [json.loads(line) for line in resp.text.splitlines()]

    return fetch


def test_prices_are_uploaded(recorded):
    run_sync()                                    # the code under test calls the fake upstream
    uploads = [r for r in recorded() if r["url"] == "/erp/sync/prices"]
    assert uploads and all(r["status"] == 200 for r in uploads)
    assert len(uploads[0]["json"]) == 5000
```

More `jq` examples:

```sh
# URLs of all POST requests
jq -r 'select(.method == "POST") | .url' run.jsonl

# number of items in each JSON array body
jq '.json | length' run.jsonl
```

To get the dump file on the host when running in Docker, mount a directory. The container runs as UID 1000, so the directory must be writable by it:

```sh
docker run --rm -p 8000:8000 \
  -e DUMP_FILE=/dump/run.jsonl -v "$PWD:/dump" \
  ghcr.io/denis1stomin/simple-http-dump-server
```

## ☸️ Kubernetes

The image runs fine with a hardened security context. Recordings are kept in memory by default, so a read-only root filesystem needs no extra volume:

```yaml
containers:
  - name: http-dump
    image: ghcr.io/denis1stomin/simple-http-dump-server:latest
    ports: [{ containerPort: 8000 }]
    securityContext:
      runAsNonRoot: true
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
```

Tests then use `GET` and `DELETE http://<service>:8000/__dump`. To keep recordings across many runs or beyond `DUMP_BUFFER_LIMIT`, add an `emptyDir` at `/tmp` and set `DUMP_FILE=/tmp/run.jsonl`.

## ☁️ Public endpoint with Azure Container Instances

Need a URL that a cloud service can reach? Run the container on ACI:

```sh
az group create --name http-dump --location centralus
CONTAINER_DNS_NAME=$(uuidgen | tr '[:upper:]' '[:lower:]')

az container create --name http-dump-server --resource-group http-dump \
  --image ghcr.io/denis1stomin/simple-http-dump-server \
  --ip-address public --ports 8000 --dns-name-label "$CONTAINER_DNS_NAME"

az container attach --name http-dump-server --resource-group http-dump   # follow the output

curl "http://$CONTAINER_DNS_NAME.centralus.azurecontainer.io:8000/some/path"
```

When you're done, delete everything with `az group delete --name http-dump`.

> ⚠️ A public endpoint accepts requests from anyone, and `GET /__dump` shows anyone what was recorded. Don't leave it running longer than you need it, and consider `DUMP_API_PATH=` (empty) or a hard-to-guess path, e.g. `DUMP_API_PATH=/$(uuidgen)`.

## 🛠️ Development

```sh
git clone https://github.com/denis1stomin/simple-http-dump-server.git
cd simple-http-dump-server
npm install
npm run lint   # ESLint
npm test       # node:test
npm start
```

### CI/CD

GitHub Actions ([`ci.yml`](.github/workflows/ci.yml)):

| Trigger             | What happens                                                                                     |
|---------------------|--------------------------------------------------------------------------------------------------|
| Push / pull request | ESLint and tests on Node 22 and 24, hadolint, multi-arch image build, container smoke test       |
| Push to `master`    | Image pushed to `ghcr.io/denis1stomin/simple-http-dump-server:master`                            |
| Push (not PRs)      | Also pushed to Docker Hub when `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets are set          |
| Tag `vX.Y.Z`        | Image tagged `X.Y.Z`, `X.Y`, `latest`; package published to npm with provenance                  |

To release, bump `version` in `package.json`, then push a matching `vX.Y.Z` tag. CI rejects the release if the tag and version don't match.

## 📜 License

[MIT](LICENSE) © Denis Istomin
