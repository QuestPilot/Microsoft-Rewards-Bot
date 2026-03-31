#!/usr/bin/env bash
set -euo pipefail

# ========================================
# Microsoft Rewards Bot - Setup (Linux/macOS)
# ========================================
# This script performs first-time setup:
#   1. Check prerequisites (Node.js, npm, Git)
#   2. Run setup wizard (accounts + config)
#   3. Install dependencies
#   4. Build TypeScript project
#
# After setup, run the bot with: npm start
# ========================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo ""
echo "========================================"
echo " Microsoft Rewards Bot - Setup"
echo "========================================"
echo ""

# Check prerequisites
echo "=== Prerequisites Check ==="
echo ""

if command -v npm >/dev/null 2>&1; then
  NPM_VERSION="$(npm -v 2>/dev/null || echo 'unknown')"
  echo "[OK] npm detected: v${NPM_VERSION}"
else
  echo "[ERROR] npm not found!"
  echo ""
  echo "Please install Node.js from: https://nodejs.org/"
  echo "Recommended version: v20 or newer"
  echo ""
  echo "Alternatively, use your package manager:"
  echo "  • Ubuntu/Debian: sudo apt install nodejs npm"
  echo "  • macOS: brew install node"
  echo "  • Fedora: sudo dnf install nodejs npm"
  exit 1
fi

if command -v git >/dev/null 2>&1; then
  GIT_VERSION="$(git --version 2>/dev/null | cut -d' ' -f3)"
  echo "[OK] Git detected: v${GIT_VERSION}"
else
  echo "[WARN] Git not detected (optional for setup, required for updates)"
  echo "  • Ubuntu/Debian: sudo apt install git"
  echo "  • macOS: brew install git"
  echo "  • Fedora: sudo dnf install git"
fi

if [ ! -f "${PROJECT_ROOT}/package.json" ]; then
  echo ""
  echo "[ERROR] package.json not found at ${PROJECT_ROOT}" >&2
  exit 1
fi

echo ""
echo "=== Running Setup Wizard ==="
echo ""

cd "${PROJECT_ROOT}"
npm run setup
EXITCODE=$?

echo ""
if [ $EXITCODE -eq 0 ]; then
  echo "========================================"
  echo " Setup Complete!"
  echo "========================================"
  echo ""
  echo "To start the bot: npm start"
  echo ""
else
  echo "========================================"
  echo " Setup Failed (Exit Code: $EXITCODE)"
  echo "========================================"
  echo ""
fi

exit $EXITCODE
