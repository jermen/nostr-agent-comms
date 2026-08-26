#!/usr/bin/env bash
set -euo pipefail

repo=${AGENT_NOSTR_REPO:-jermen/nostr-agent-comms}
ref=${AGENT_NOSTR_REF:-main}
skill_name=nostr-agent-comms
platform=$(uname -s)

dry_run=0
install_cli=1
install_codex=1
install_claude=1

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Install the agent-nostr CLI and the nostr-agent-comms skill for Codex and Claude Code.

Options:
  --dry-run       Show what would be installed without changing anything.
  --no-cli        Do not install the agent-nostr CLI.
  --no-codex      Do not install the Codex skill.
  --no-claude     Do not install the Claude Code skill.
  -h, --help      Show this help.

Environment:
  AGENT_NOSTR_REPO       GitHub repository to download when run via curl.
                         Default: jermen/nostr-agent-comms
  AGENT_NOSTR_REF        Git ref to download. Default: main
  AGENT_NOSTR_INSTALL_DIR
                         CLI data directory; passed to the CLI installer.
  AGENT_NOSTR_BIN_DIR    CLI binary directory; passed to the CLI installer.
  XDG_DATA_HOME          Overrides the platform-specific CLI data directory.
  XDG_CONFIG_HOME        Overrides the platform-specific CLI config directory.
  CODEX_HOME             Codex config root. Default: ~/.codex
  CLAUDE_CONFIG_DIR      Claude Code config root. Default: ~/.claude
USAGE
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --no-cli) install_cli=0 ;;
    --no-codex) install_codex=0 ;;
    --no-claude) install_claude=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if (( ! install_cli && ! install_codex && ! install_claude )); then
  echo "Nothing selected for installation." >&2
  exit 2
fi

command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }

tmp_root=""
cleanup() {
  if [[ -n "$tmp_root" && -d "$tmp_root" ]]; then
    rm -rf -- "$tmp_root"
  fi
}
trap cleanup EXIT

# When run from a checkout, use that checkout. When piped to bash, fetch a
# clean source archive from GitHub first.
source_root=""
script_path=${BASH_SOURCE[0]:-}
if [[ -n "$script_path" && -f "$script_path" ]]; then
  candidate=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)
  if [[ -f "$candidate/SKILL.md" && -f "$candidate/scripts/install-agent-nostr.sh" ]]; then
    source_root=$candidate
  fi
fi

fetch_archive() {
  local url=$1
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --https-only "$url"
  else
    echo "curl or wget is required when install.sh is run without a local checkout" >&2
    return 1
  fi
}

if [[ -z "$source_root" ]]; then
  tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/nostr-agent-comms.XXXXXXXX")
  archive_url="https://github.com/${repo}/archive/${ref}.tar.gz"
  echo "Downloading ${repo}@${ref}..." >&2
  fetch_archive "$archive_url" | tar -xzf - -C "$tmp_root" --strip-components=1
  source_root=$tmp_root
fi

for required in \
  "$source_root/SKILL.md" \
  "$source_root/scripts/install-agent-nostr.sh" \
  "$source_root/scripts/agent-nostr/agent-nostr.mjs" \
  "$source_root/scripts/agent-nostr/package.json"; do
  [[ -f "$required" ]] || { echo "Invalid source tree: missing ${required#$source_root/}" >&2; exit 1; }
done

codex_root=${CODEX_HOME:-"$HOME/.codex"}
claude_root=${CLAUDE_CONFIG_DIR:-"$HOME/.claude"}
cli_bin_dir=${AGENT_NOSTR_BIN_DIR:-"$HOME/.local/bin"}
codex_skill="$codex_root/skills/$skill_name"
claude_skill="$claude_root/skills/$skill_name"

copy_skill() {
  local dest=$1
  local parent stage
  parent=$(dirname -- "$dest")

  if (( dry_run )); then
    printf 'Would install skill: %s -> %s\n' "$source_root" "$dest"
    return
  fi

  mkdir -p -- "$parent"
  stage=$(mktemp -d "$parent/.${skill_name}.XXXXXXXX")

  # Copy only the skill payload. Exclude local dependency/build directories if
  # this installer is being run from a developer checkout.
  tar --exclude='.git' --exclude='node_modules' \
    -C "$source_root" -cf - SKILL.md agents references scripts \
    | tar -C "$stage" -xf -

  rm -rf -- "$dest"
  mv -- "$stage" "$dest"
  printf 'Installed skill: %s\n' "$dest"
}

if (( install_cli )); then
  if (( dry_run )); then
    bash "$source_root/scripts/install-agent-nostr.sh" --dry-run
  else
    bash "$source_root/scripts/install-agent-nostr.sh"
  fi
fi

if (( install_codex )); then
  copy_skill "$codex_skill"
fi

if (( install_claude )); then
  copy_skill "$claude_skill"
fi

if (( dry_run )); then
  exit 0
fi

cat <<EOF2

nostr-agent-comms installation complete.

CLI:
  ${cli_bin_dir}/agent-nostr
EOF2

if (( install_codex )); then
  printf 'Codex skill:\n  %s\n' "$codex_skill"
fi
if (( install_claude )); then
  printf 'Claude Code skill:\n  %s\n' "$claude_skill"
fi

if [[ $platform == Darwin ]]; then
  printf '\nIf %s is not already on PATH, add it in ~/.zprofile before using agent-nostr.\n' "$cli_bin_dir"
else
  printf '\nIf %s is not already on PATH, add it before using agent-nostr.\n' "$cli_bin_dir"
fi
printf '%s\n' 'Start a new Codex/Claude Code session if the newly installed skill is not detected immediately.'
