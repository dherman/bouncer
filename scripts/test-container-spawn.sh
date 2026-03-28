#!/usr/bin/env bash
# Test container spawn + stdio piping: build image, spawn cat container,
# verify bidirectional stdin/stdout, then kill and verify cleanup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOCKERFILE="$PROJECT_DIR/docker/agent.Dockerfile"

# Build or reuse the agent image (same hash logic as container.ts)
HASH=$(shasum -a 256 "$DOCKERFILE" | cut -c1-12)
IMAGE_TAG="bouncer-agent:${HASH}"

CONTAINER_NAME="bouncer-spawn-test-$$"
ORPHAN_NAME="bouncer-orphan-test-$$"
TMPDIR_TEST=$(mktemp -d)
FIFO_IN="$TMPDIR_TEST/stdin.fifo"

cleanup() {
  kill "$DOCKER_PID" 2>/dev/null || true
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  docker rm -f "$ORPHAN_NAME" 2>/dev/null || true
  rm -rf "$TMPDIR_TEST"
}
trap cleanup EXIT

echo "=== Ensuring image $IMAGE_TAG exists ==="
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  docker build -t "$IMAGE_TAG" -f "$DOCKERFILE" "$PROJECT_DIR/docker/"
fi

echo ""
echo "=== Testing bidirectional stdio ==="
TEST_MSG="hello-from-bouncer-$(date +%s)"

mkfifo "$FIFO_IN"
docker run -i --rm --name "$CONTAINER_NAME" \
  --label bouncer.managed=true \
  --label "bouncer.sessionId=spawn-test-$$" \
  "$IMAGE_TAG" cat < "$FIFO_IN" > "$TMPDIR_TEST/stdout.txt" &
DOCKER_PID=$!
sleep 2

# Write test message through the FIFO, then close it so cat exits
echo "$TEST_MSG" > "$FIFO_IN"
# Give cat a moment to echo back and exit
sleep 1

RESULT=$(cat "$TMPDIR_TEST/stdout.txt")
if [ "$RESULT" = "$TEST_MSG" ]; then
  echo "PASS: Echoed message matches ('$RESULT')"
else
  echo "FAIL: Expected '$TEST_MSG', got '$RESULT'"
  exit 1
fi

echo ""
echo "=== Testing cleanup ==="
# Container should already be gone (cat exited, --rm removes it)
# Force remove anyway to test idempotency
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "FAIL: Container still exists after cleanup!"
  exit 1
else
  echo "PASS: Container cleaned up successfully"
fi

echo ""
echo "=== Testing orphan cleanup pattern (label-based) ==="
docker run -d --name "$ORPHAN_NAME" \
  --label bouncer.managed=true \
  --label "bouncer.sessionId=orphan-test-$$" \
  "$IMAGE_TAG" sleep 300 >/dev/null

if ! docker inspect "$ORPHAN_NAME" >/dev/null 2>&1; then
  echo "FAIL: Could not create orphan container"
  exit 1
fi
echo "Orphan container created: $ORPHAN_NAME"

# Discover via label filter (matches cleanupOrphanContainers logic)
FOUND=$(docker ps -a --filter "label=bouncer.managed=true" \
  --format '{{.Label "bouncer.sessionId"}}\t{{.Names}}')
echo "Found managed containers:"
echo "$FOUND"

if ! echo "$FOUND" | grep -q "$ORPHAN_NAME"; then
  echo "FAIL: Orphan not found via label filter"
  exit 1
fi

docker rm -f "$ORPHAN_NAME" >/dev/null
if docker inspect "$ORPHAN_NAME" >/dev/null 2>&1; then
  echo "FAIL: Orphan container still exists!"
  exit 1
else
  echo "PASS: Orphan container removed via label-based discovery"
fi

echo ""
echo "=== All spawn tests passed ==="
