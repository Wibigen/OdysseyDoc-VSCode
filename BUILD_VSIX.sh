#!/usr/bin/env bash
# Builds OdysseyDoc-v4.0.vsix next to this script (Linux / WSL / macOS).
# KEEP_NODE_MODULES=1 keeps node_modules; INSTALL=1 installs it into VS Code.
set -euo pipefail
cd "$(dirname "$0")"
VSIX="OdysseyDoc-v4.0.vsix"
command -v npm >/dev/null || { echo "npm not found: install Node.js (LTS)"; exit 1; }
echo "[1/4] npm install";  npm install --no-audit --no-fund --loglevel=error
echo "[2/4] compile";      npm run -s compile
echo "[3/4] package";      npx --no-install vsce package --no-dependencies -o "$VSIX"
echo "[4/4] clean up";     rm -rf dist out out-test
[ "${KEEP_NODE_MODULES:-0}" = "1" ] || rm -rf node_modules
echo "OK: $(pwd)/$VSIX"
if [ "${INSTALL:-1}" = "1" ] && command -v code >/dev/null; then code --install-extension "$(pwd)/$VSIX" --force; fi
