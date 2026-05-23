#!/bin/zsh
cd "$(dirname "$0")" || exit 1

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/Applications/Codex.app/Contents/Resources/node" ]; then
  NODE_BIN="/Applications/Codex.app/Contents/Resources/node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js is required to run the local test server."
  echo "Install Node.js, then double-click this file again."
  read "?Press Return to close this window."
  exit 1
fi

if [ ! -f ".env" ]; then
  cp ".env.example" ".env"
  echo "Created .env from .env.example."
  echo "Open .env and add POWER_AUTOMATE_WEBHOOK_URL before testing submissions."
fi

if curl -fsS "http://127.0.0.1:3000/" >/dev/null 2>&1; then
  echo "The local site is already running at http://localhost:3000/"
  open "http://localhost:3000/"
  read "?Press Return to close this window."
  exit 0
fi

echo "Starting Collette intake form at http://localhost:3000/"
"$NODE_BIN" server.js &
SERVER_PID=$!

for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:3000/" >/dev/null 2>&1; then
    open "http://localhost:3000/"
    echo "Site is ready. Keep this window open while testing."
    echo "Press Control-C to stop the local server."
    wait "$SERVER_PID"
    exit $?
  fi

  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "The local server stopped before it was ready."
    wait "$SERVER_PID"
    read "?Press Return to close this window."
    exit 1
  fi

  sleep 0.5
done

echo "The local server started, but the browser test did not respond in time."
echo "Try opening http://localhost:3000/ manually, or press Control-C and run this again."
wait "$SERVER_PID"
