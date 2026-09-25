#!/usr/bin/env bash
# Builds dist/broetry-blocker-chrome.zip for the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
mkdir -p dist
rm -f "dist/broetry-blocker-chrome-${version}.zip"
(cd extension && zip -qr "../dist/broetry-blocker-chrome-${version}.zip" . -x "icons/icon.svg" -x ".*")
echo "dist/broetry-blocker-chrome-${version}.zip"
