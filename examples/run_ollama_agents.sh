#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$ROOT_DIR/.venv/bin/python}"
MODEL="${OLLAMA_MODEL:-gemma4:latest}"
OLLAMA_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
HOST="${A2A_HOST:-127.0.0.1}"

PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT INT TERM

echo "Starting Ollama-backed A2A test agents"
echo "Model: $MODEL"
echo "Ollama URL: $OLLAMA_URL"

"$PYTHON_BIN" "$ROOT_DIR/examples/ollama_a2a_agent.py" \
  --agent assistant \
  --host "$HOST" \
  --port 5555 \
  --model "$MODEL" \
  --ollama-url "$OLLAMA_URL" &
PIDS+=("$!")

"$PYTHON_BIN" "$ROOT_DIR/examples/ollama_a2a_agent.py" \
  --agent structured \
  --host "$HOST" \
  --port 5556 \
  --model "$MODEL" \
  --ollama-url "$OLLAMA_URL" &
PIDS+=("$!")

echo
echo "Agent Card URLs:"
echo "  Assistant:  http://$HOST:5555/"
echo "  Structured: http://$HOST:5556/"
echo
echo "Open the inspector and connect to either URL."
echo "Press Ctrl+C to stop both agents."

wait "${PIDS[@]}"
