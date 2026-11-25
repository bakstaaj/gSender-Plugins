#!/usr/bin/env bash
set -euo pipefail

source_dir="$PWD"
if [[ -n "${GSENDER_PLUGIN_DIR:-}" ]]; then
  target_dir="$GSENDER_PLUGIN_DIR"
else
  target_dir="$(cygpath -u "${APPDATA:?Set APPDATA or GSENDER_PLUGIN_DIR}")/gSender/plugins/com.bakstaaj.carve-studio"
fi

if [[ ! -f "$source_dir/gsender-plugin.json" || ! -f "$source_dir/ui/index.html" ]]; then
  echo "Build Carve Studio before deploying it." >&2
  exit 1
fi

/usr/bin/mkdir -p "$target_dir/ui"
/usr/bin/cp "$source_dir/gsender-plugin.json" "$target_dir/gsender-plugin.json"
/usr/bin/cp -R "$source_dir/ui/." "$target_dir/ui/"
echo "Deployed Carve Studio to $target_dir"
