#!/bin/bash
# Installs the workspace dependencies so builds, typechecks and tests work in a
# fresh Claude Code on the web session.
#
# Without this, a session starts with only a partial node_modules: `vite` is
# missing, so `npm run build` fails at the web workspace, and the server's
# ffmpeg/ffprobe binaries are absent, so the video tests cannot run.
set -euo pipefail

# Only needed in the remote container; a local checkout is already set up.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# `npm install` rather than `npm ci`: it is idempotent, it is a no-op once the
# container state is cached, and it does not delete node_modules on every run.
# This installs every workspace (root, server, web) in one pass.
npm install --no-audit --no-fund
