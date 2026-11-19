# devailoop-runner

The runner of DevAILoop: the one service of a worker PC that is given the Docker socket. The socket is root-equivalent on the PC, so the runner never downloads code at run time, and its source is published here for you to audit. Everything else from DevAILoop stays private.

The image is built from exactly this source (`apps/runner/Dockerfile`) and published as `ghcr.io/<owner>/devailoop-runner:<version>`, the only public DevAILoop image. Each release of this repository is a tag `v<version>`, the version of the image. Your `docker-compose.worker.yml` pins the runner by that version; to update, change the pin.

| Path | What it is |
| --- | --- |
| `apps/runner/src` | The runner: what it accepts from the worker, and every `docker` command it builds |
| `apps/runner/seccomp/agent.json` | The system-call filter of the Agent's containers |
| `apps/runner/src/agent-base.ts`, `apps/runner/agent-base` | The `devailoop-agent-base` image the runner builds on your PC |
| `apps/runner/Dockerfile`, `apps/runner/bundle.mjs` | The image build |
| `packages/runner-shared` | The few definitions the runner shares with DevAILoop |
| `docker/worker-entrypoint.mjs` | The worker container's entrypoint, which fetches the worker's code from your server |
| `docker/check-image-source.sh` | The check that the image holds no other DevAILoop code |

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
docker build -f apps/runner/Dockerfile --build-arg DEVAILOOP_VERSION=dev -t devailoop-runner .
docker/check-image-source.sh devailoop-runner
```

This repository is written by DevAILoop's release workflow; changes are not taken here.
