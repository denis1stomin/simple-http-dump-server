# simple-http-dump-server

[![CI](https://github.com/denis1stomin/simple-http-dump-server/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/denis1stomin/simple-http-dump-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/simple-http-dump-server?logo=npm)](https://www.npmjs.com/package/simple-http-dump-server)
[![npm downloads](https://img.shields.io/npm/dm/simple-http-dump-server?logo=npm)](https://www.npmjs.com/package/simple-http-dump-server)
[![Docker image](https://img.shields.io/badge/ghcr.io-simple--http--dump--server-2496ED?logo=docker&logoColor=white)](https://github.com/denis1stomin/simple-http-dump-server/pkgs/container/simple-http-dump-server)
[![Node.js](https://img.shields.io/node/v/simple-http-dump-server?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/github/license/denis1stomin/simple-http-dump-server)](LICENSE)

> A tiny HTTP server that answers **every** request with an empty `200 OK` and shows you exactly what was sent.

Point a webhook, a client under test or a misbehaving integration at it and see the method, path, headers and body of every request. Think of it as a self-hosted RequestBin in one dependency and ~100 lines of code.

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
- **Readable output.** One block per request: summary line, request line, headers, then the raw body.
- **Machine-readable dump.** Optional [JSON Lines](https://jsonlines.org) file you can process with `jq` or a script.
- **Doesn't leak credentials.** `Authorization`, `Proxy-Authorization`, `Cookie` and `X-Api-Key` are always printed as `<redacted>`.
- **Easy to run.** `npx`, a multi-arch Docker image (amd64/arm64), or a public endpoint on Azure Container Instances.
- **Container-friendly.** Runs as a non-root user and shuts down cleanly on `docker stop`.

## 🚀 Quick start

**npx** (Node.js 22+):

```sh
npx simple-http-dump-server
```

**Docker:**

```sh
docker run --rm -p 8000:8000 ghcr.io/denis1stomin/simple-http-dump-server
```

Then send it something:

```sh
curl -X POST http://localhost:8000/some/path \
  -H 'content-type: application/json' \
  -d '{"SomeProp": "value"}'
```

## ⚙️ Configuration

All settings are environment variables.

| Variable     | Default | Description                                                              |
|--------------|---------|--------------------------------------------------------------------------|
| `PORT`       | `8000`  | Port to listen on.                                                       |
| `BODY_LIMIT` | `50mb`  | Max request body size (`100kb`, `10mb`, ...). Larger bodies get a `413`. |
| `DUMP_FILE`  | (unset) | If set, append one JSON line per request to this file.                   |

```sh
PORT=9000 BODY_LIMIT=200mb DUMP_FILE=run.jsonl npx simple-http-dump-server
```

## 📄 JSON Lines dump

With `DUMP_FILE` set, each request is also written as one JSON object per line. Only the `content-type` and `content-length` headers are kept, so nothing sensitive ends up in the file:

```json
{"ts":"2026-10-07T08:30:32.270Z","method":"POST","url":"/some/path","headers":{"content-type":"application/json","content-length":"21"},"body":"{\"SomeProp\": \"value\"}"}
```

Example: list the URLs of all POST requests:

```sh
jq -r 'select(.method == "POST") | .url' run.jsonl
```

To get the dump file on the host when running in Docker, mount a directory. The container runs as the `node` user, so the directory must be writable by it:

```sh
docker run --rm -p 8000:8000 \
  -e DUMP_FILE=/dump/run.jsonl -v "$PWD:/dump" \
  ghcr.io/denis1stomin/simple-http-dump-server
```

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
| Tag `vX.Y.Z`        | Image tagged `X.Y.Z`, `X.Y`, `latest`; package published to npm with provenance                  |

To release, bump `version` in `package.json`, then push a matching `vX.Y.Z` tag. CI rejects the release if the tag and version don't match.

## 📜 License

[MIT](LICENSE) © Denis Istomin
