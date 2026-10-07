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
- **Machine-readable dump.** Optional [JSON Lines](https://jsonlines.org) file with full bodies and JSON already parsed, ready for `jq`.
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

| Variable         | Default | Description                                                                    |
|------------------|---------|--------------------------------------------------------------------------------|
| `PORT`           | `8000`  | Port to listen on.                                                             |
| `BODY_LIMIT`     | `50mb`  | Max request body size (`100kb`, `10mb`, ...). Larger bodies get a `413`.       |
| `LOG_BODY_LIMIT` | `4kb`   | Max body bytes printed to stdout; the rest is cut with `… (truncated, N bytes total)`. `0` hides bodies. |
| `DUMP_FILE`      | (unset) | If set, append one JSON line per request (full body) to this file.             |

If `DUMP_FILE` can't be opened (missing directory, read-only filesystem), the server exits at startup with a one-line error instead of failing on the first request.

```sh
PORT=9000 BODY_LIMIT=200mb DUMP_FILE=run.jsonl npx simple-http-dump-server
```

## 📄 JSON Lines dump

With `DUMP_FILE` set, each request is also written as one JSON object per line:

```json
{"ts":"2026-10-07T08:30:32.270Z","method":"POST","url":"/some/path","status":200,"headers":{"content-type":"application/json","content-length":"21"},"body":"{\"SomeProp\": \"value\"}","json":{"SomeProp":"value"}}
```

| Field     | Description                                                                                  |
|-----------|----------------------------------------------------------------------------------------------|
| `ts`      | Time the response was sent (ISO 8601).                                                       |
| `method`, `url` | Request method and URL (with query string).                                            |
| `status`  | Status the server answered with: `200`, or `413` for bodies over `BODY_LIMIT`.               |
| `headers` | Only `content-type` and `content-length`, so no credentials end up in the file.              |
| `body`    | Full body as UTF-8 text (empty for rejected requests).                                       |
| `json`    | Parsed body, present only when the content type is JSON (`application/json`, `*+json`) and the body parses. |

Examples:

```sh
# URLs of all POST requests
jq -r 'select(.method == "POST") | .url' run.jsonl

# requests that were rejected
jq -c 'select(.status != 200) | {ts, url, status}' run.jsonl

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

The image runs fine with a hardened security context. With a read-only root filesystem, point `DUMP_FILE` at a writable volume:

```yaml
containers:
  - name: http-dump
    image: ghcr.io/denis1stomin/simple-http-dump-server:latest
    ports: [{ containerPort: 8000 }]
    env:
      - { name: DUMP_FILE, value: /tmp/run.jsonl }
    securityContext:
      runAsNonRoot: true
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
    volumeMounts:
      - { name: tmp, mountPath: /tmp }
volumes:
  - { name: tmp, emptyDir: {} }
```

Get the dump with `kubectl cp <pod>:/tmp/run.jsonl run.jsonl`.

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

> ⚠️ A public endpoint accepts requests from anyone. Don't leave it running longer than you need it.

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
