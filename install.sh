#!/usr/bin/env bash
# Gentle-ai-mod installer (Linux/macOS)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required on PATH (Node 18+)" >&2
  exit 1
fi
exec node "$ROOT/install.mjs" "$@"
