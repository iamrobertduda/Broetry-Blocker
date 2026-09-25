#!/usr/bin/env bash
# Wraps the web extension in a Safari app project (macOS + Xcode required).
# Afterwards open safari/Broetry Blocker/Broetry Blocker.xcodeproj, pick a
# signing team and run it; then enable the extension in Safari > Settings.
set -euo pipefail
cd "$(dirname "$0")/.."
bundle_id="${BUNDLE_ID:-com.example.broetryblocker}"
xcrun safari-web-extension-converter extension \
  --project-location safari \
  --app-name "Broetry Blocker" \
  --bundle-identifier "$bundle_id" \
  --swift \
  --copy-resources \
  --no-open \
  --force
