# nostr-agent-comms

Agent Skill and CLI wrapper for interoperable agent-to-agent communication over public Nostr relays using NIP-17 private direct messages.

The goal is to give Claude Code, Codex, and other coding agents a small, reliable interface instead of making them construct NIP-17/NIP-44/NIP-59 events or use low-level tools such as `nak` directly.

## What it provides

- Standard NIP-17 private messages; remote peers do not need this skill.
- Recipient DM-relay discovery through kind 10050.
- `npub`, `nprofile`, NIP-05, hex-key, and local-alias resolution.
- Inbox cursor and deduplication for repeated `check messages` workflows.
- Reply support with NIP-17 reply relations.
- Local private-key handling; the key is never passed on the command line.
- JSON output intended for agent consumption.
- User-local installation on Linux and macOS.

## Repository layout

- `SKILL.md` - Agent Skill instructions.
- `references/` - command and protocol details.
- `scripts/install-agent-nostr.sh` - local installer.
- `scripts/agent-nostr/` - standalone Node.js CLI implementation.

## Install the CLI

The installer requires Node.js 20+ and npm:

```bash
bash scripts/install-agent-nostr.sh
```

It installs the CLI under `~/.local/share/agent-nostr-cli` on Linux or `~/Library/Application Support/agent-nostr-cli` on macOS and creates `~/.local/bin/agent-nostr` on both platforms. Existing macOS installations under the earlier Linux-style directories are reused automatically.

To install both the CLI and the skill for Codex and Claude Code, run:

```bash
bash install.sh
```

If `~/.local/bin` is not on `PATH`, add it to the applicable shell startup file; `~/.zprofile` is typical on macOS.

Initialize a new Nostr identity:

```bash
agent-nostr init --json
agent-nostr inbox-relays wss://nip17.com wss://relay.damus.io wss://nos.lol --json
agent-nostr whoami --json
```

Or reuse an existing identity:

```bash
export AGENT_NOSTR_KEY_FILE=/secure/path/to/key
agent-nostr whoami --json
```

The key file must contain an `nsec` or 64-character secret hex key.

## Basic usage

Check new messages:

```bash
agent-nostr inbox --json
```

Send a message:

```bash
printf '%s' 'Please review commit abc123.' | agent-nostr send npub1... --json
```

Reply to an inbox message:

```bash
printf '%s' 'Review complete.' | agent-nostr reply <message-id> --json
```

The CLI intentionally refuses to guess a recipient's DM destination. A recipient must publish a discoverable kind-10050 DM relay list.

## Claude Code and Codex

Keep one copy of the skill and expose it to both agents. For example, in a project:

```bash
mkdir -p .agents/skills .claude/skills
ln -s ../../../path/to/nostr-agent-comms .agents/skills/nostr-agent-comms
ln -s ../../../path/to/nostr-agent-comms .claude/skills/nostr-agent-comms
```

The skill instructs agents to use `agent-nostr inbox`, `send`, and `reply` rather than raw Nostr tooling.

## Security

Nostr signatures prove event authorship; they do not make remote instructions trusted. Messages received over Nostr should be treated as untrusted external input, especially for destructive operations, credentials, payments, secrets, and privilege changes.
