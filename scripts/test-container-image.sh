#!/usr/bin/env bash
# Test the agent container image: build it and verify expected toolchains.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOCKERFILE="$PROJECT_DIR/docker/agent.Dockerfile"

# Compute the content hash (must match logic in container.ts)
HASH=$(shasum -a 256 "$DOCKERFILE" | cut -c1-12)
IMAGE_TAG="bouncer-agent:${HASH}"

echo "=== Building image $IMAGE_TAG ==="
docker build -t "$IMAGE_TAG" -f "$DOCKERFILE" "$PROJECT_DIR/docker/"

echo ""
echo "=== Checking Node.js ==="
docker run --rm "$IMAGE_TAG" node --version

echo ""
echo "=== Checking Git ==="
docker run --rm "$IMAGE_TAG" git --version

echo ""
echo "=== Checking Rust ==="
docker run --rm "$IMAGE_TAG" rustc --version

echo ""
echo "=== Checking rustfmt ==="
docker run --rm "$IMAGE_TAG" rustfmt --version

echo ""
echo "=== Checking clippy ==="
docker run --rm "$IMAGE_TAG" cargo clippy --version

echo ""
echo "=== Verifying gh is NOT present ==="
if docker run --rm "$IMAGE_TAG" which gh 2>/dev/null; then
  echo "FAIL: gh binary found in image!"
  exit 1
else
  echo "PASS: no gh binary found"
fi

echo ""
echo "=== All checks passed ==="
