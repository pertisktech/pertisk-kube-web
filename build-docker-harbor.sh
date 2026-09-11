#!/usr/bin/env bash
set -euo pipefail

VERSION="${VERSION:-0.2.9}"
IMAGE="harbor.tools.pertisk.com/pertisksoft/pertisk-kube/web:${VERSION}"

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --provenance=false \
  --build-arg VERSION="${VERSION}" \
  -t "${IMAGE}" \
  -f Dockerfile \
  --push .

make helm-package VERSION="${VERSION}"
