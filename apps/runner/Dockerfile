# The runner: starts the Agent's sessions in containers and builds devailoop-agent-base. It alone is
# given the Docker socket, which is root-equivalent on the PC it runs on, so it is published as source
# (https://github.com/<owner>/devailoop-runner) and as the only public image. This file builds from
# that source alone: the context is the root of the public repository, or of DevAILoop's repository.
#   docker build -f apps/runner/Dockerfile --build-arg DEVAILOOP_VERSION=1.2.3 .

FROM node:24-bookworm-slim AS bundle
# The bundler, at the version DevAILoop's repository pins (a test keeps them equal).
ARG ESBUILD_VERSION=0.28.2
WORKDIR /app
RUN npm install --no-save --no-package-lock --ignore-scripts esbuild@${ESBUILD_VERSION}
COPY apps/runner apps/runner
COPY packages/runner-shared packages/runner-shared
RUN node apps/runner/bundle.mjs /out

FROM node:24-bookworm-slim AS runner
# CA certificates: the buildx client in this container fetches registry tokens over HTTPS for the builder (FROM node:..., FROM alpine:...).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The runner's own version (semver, independent of the server's); the runner tells the worker, which reports it to the server.
ARG DEVAILOOP_VERSION=dev
ENV DEVAILOOP_VERSION=$DEVAILOOP_VERSION
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
# buildx: the runner builds Environment images with `docker buildx build` in a docker-container builder of its own (src/builder.ts), so the builder's limits apply.
COPY --from=docker:28-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
WORKDIR /app
COPY --from=bundle /out/ /app/
ENV NODE_ENV=production
CMD ["node", "/app/dist/main.js"]
