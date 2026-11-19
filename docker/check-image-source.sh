#!/bin/sh
# Fails if the published runner image (or any other image given) holds DevAILoop's source: any .ts file outside
# node_modules, apps/server, apps/web, packages/*/src, or a @devailoop package in node_modules.
# With --tarball it checks a .tar.gz instead, the worker bundle the server image carries, and also
# fails on any claude-agent-sdk package: the bundle never holds Claude Code.
# Usage: docker/check-image-source.sh <image>   (lists the files with `docker create` and
# `docker export`, so nothing in the image is run), or
#        docker/check-image-source.sh --list <file>   (a list of paths, one per line), or
#        docker/check-image-source.sh --tarball <file.tar.gz>.
set -eu

sdk=""
what=image
if [ "${1:-}" = "--list" ]; then
  list="$2"
elif [ "${1:-}" = "--tarball" ]; then
  list="$(mktemp)"
  trap 'rm -f "$list"' EXIT
  tar -tzf "${2:?usage: check-image-source.sh --tarball <file.tar.gz>}" > "$list"
  sdk=1
  what=bundle
else
  image="${1:?usage: check-image-source.sh <image> | --list <file>}"
  list="$(mktemp)"
  container="$(docker create "$image")"
  trap 'docker rm -f "$container" >/dev/null; rm -f "$list"' EXIT
  docker export "$container" | tar -t > "$list"
fi

bad="$(sed 's|^\./||; s|^/||' "$list" | grep -E '(^|/)apps/(server|web)(/|$)|(^|/)packages/[^/]+/src(/|$)|(^|/)node_modules/(\.pnpm/)?@devailoop[+/]|\.ts$' \
  | grep -Ev '(^|/)node_modules/' | head -n 50 || true)"
# .ts outside node_modules is covered above; the next two rules apply inside node_modules.
inside="$(sed 's|^\./||; s|^/||' "$list" | grep -E '(^|/)node_modules/(\.pnpm/)?@devailoop[+/]' | head -n 50 || true)"
if [ -n "$sdk" ]; then
  # Any path naming the SDK or one of its platform packages (`claude-agent-sdk`, `claude-agent-sdk-linux-x64`, `@anthropic-ai+claude-agent-sdk@...`).
  inside="$inside
$(sed 's|^\./||; s|^/||' "$list" | grep -E 'claude-agent-sdk' | head -n 50 || true)"
fi
found="$(printf '%s\n%s\n' "$bad" "$inside" | sed '/^$/d' | sort -u)"

if [ -n "$found" ]; then
  echo "The $what holds DevAILoop source${sdk:+ or the Agent SDK}:" >&2
  echo "$found" >&2
  exit 1
fi
echo "No DevAILoop source in the $what."
