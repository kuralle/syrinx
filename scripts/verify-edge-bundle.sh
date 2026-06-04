#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/.edge-build"
OUT_FILE="$OUT_DIR/worker.js"
PROVIDER_OUT_FILE="$OUT_DIR/provider-cartesia.js"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

pnpm --dir "$ROOT" --filter @asyncdot/voice-server-workers exec esbuild "$ROOT/packages/voice-server-workers/src/worker.ts" \
  --bundle \
  --format=esm \
  --platform=browser \
  --conditions=workerd,worker,browser \
  --outfile="$OUT_FILE" \
  --log-level=warning

pnpm --dir "$ROOT" --filter @asyncdot/voice-server-workers exec esbuild "$ROOT/packages/voice-tts-cartesia/src/index.ts" \
  --bundle \
  --format=esm \
  --platform=browser \
  --conditions=workerd,worker,browser \
  --outfile="$PROVIDER_OUT_FILE" \
  --log-level=warning

for pattern in 'from "ws"' 'onnxruntime-node' 'node:net' 'node:http' 'node:tls' 'createServer(' '.handleUpgrade('; do
  if grep -Fq "$pattern" "$OUT_FILE" "$PROVIDER_OUT_FILE"; then
    echo "edge bundle contains forbidden pattern: $pattern" >&2
    exit 1
  fi
done

echo "edge bundle clean: $OUT_FILE $PROVIDER_OUT_FILE"
