#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
src_dir="$script_dir/nostr-agent"
platform=$(uname -s)
case "$platform" in
  Darwin)
    if [[ -n ${XDG_DATA_HOME:-} ]]; then
      default_data_home=$XDG_DATA_HOME
    elif [[ -d "$HOME/.local/share/nostr-agent-cli" || -d "$HOME/.local/share/agent-nostr-cli" ]]; then
      default_data_home="$HOME/.local/share"
    else
      default_data_home="$HOME/Library/Application Support"
    fi
    ;;
  *)
    default_data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
    ;;
esac
# NOSTR_AGENT_* wins; the pre-rename AGENT_NOSTR_* names keep working.
install_dir=${NOSTR_AGENT_INSTALL_DIR:-${AGENT_NOSTR_INSTALL_DIR:-"$default_data_home/nostr-agent-cli"}}
bin_dir=${NOSTR_AGENT_BIN_DIR:-${AGENT_NOSTR_BIN_DIR:-"$HOME/.local/bin"}}
legacy_install_dir="$default_data_home/agent-nostr-cli"
dry_run=0

if [[ ${1:-} == "--dry-run" ]]; then
  dry_run=1
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js >= 20 with npm is required" >&2
  if [[ $platform == Darwin ]]; then
    echo "Install it separately with Homebrew or a user-scoped version manager, then rerun this installer." >&2
  fi
  exit 1
fi

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if (( node_major < 20 )); then
  echo "Node.js >= 20 is required (found $(node --version))" >&2
  exit 1
fi

if (( dry_run )); then
  printf 'platform: %s\nsource: %s\ninstall: %s\nbin: %s/nostr-agent\ncompat: %s/agent-nostr\n' \
    "$platform" "$src_dir" "$install_dir" "$bin_dir" "$bin_dir"
  exit 0
fi

mkdir -p "$install_dir" "$bin_dir"
cp "$src_dir/package.json" "$src_dir/package-lock.json" "$src_dir/nostr-agent.mjs" "$install_dir/"
(
  cd "$install_dir"
  npm ci --omit=dev --no-audit --no-fund
)
chmod 755 "$install_dir/nostr-agent.mjs"
ln -sfn "$install_dir/nostr-agent.mjs" "$bin_dir/nostr-agent"
# Deprecated pre-rename name, kept for at least one transition release.
ln -sfn "$install_dir/nostr-agent.mjs" "$bin_dir/agent-nostr"

printf 'Installed %s\n' "$bin_dir/nostr-agent"
printf 'Deprecated alias %s now points to the same CLI.\n' "$bin_dir/agent-nostr"
if [[ -d "$legacy_install_dir" && "$legacy_install_dir" != "$install_dir" ]]; then
  printf 'The previous installation %s is no longer used and can be removed.\n' "$legacy_install_dir"
fi
printf 'If %s is not on PATH, add it to your shell PATH.\n' "$bin_dir"
