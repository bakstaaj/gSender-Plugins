#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f ui/index.html ]] || { echo 'Built UI not found. Run npm run build first.' >&2; exit 1; }
archive="camlab-v$(node -p "require('./gsender-plugin.json').version").zip"
rm -f "$archive"
zip -q -r "$archive" gsender-plugin.json README.md THIRD_PARTY_NOTICES.md ui
echo "Created $(pwd)/$archive"
