#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
src_dir="$script_dir/agent-nostr"
install_dir=${AGENT_NOSTR_INSTALL_DIR:-"$HOME/.local/share/agent-nostr-cli"}
bin_dir=${AGENT_NOSTR_BIN_DIR:-"$HOME/.local/bin"}
dry_run=0

if [[ ${1:-} == "--dry-run" ]]; then
  dry_run=1
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if (( node_major < 20 )); then
  echo "Node.js >= 20 is required (found $(node --version))" >&2
  exit 1
fi

if (( dry_run )); then
  printf 'source: %s\ninstall: %s\nbin: %s/agent-nostr\n' "$src_dir" "$install_dir" "$bin_dir"
  exit 0
fi

mkdir -p "$install_dir" "$bin_dir"
cp "$src_dir/package.json" "$src_dir/agent-nostr.mjs" "$install_dir/"
(
  cd "$install_dir"
  npm install --omit=dev --no-audit --no-fund
)
cat > "$bin_dir/agent-nostr" <<EOF2
#!/bin/sh
exec node "$install_dir/agent-nostr.mjs" "\$@"
EOF2
chmod 755 "$bin_dir/agent-nostr"

printf 'Installed %s\n' "$bin_dir/agent-nostr"
printf 'If %s is not on PATH, add it to your shell PATH.\n' "$bin_dir"
