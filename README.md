# nostr-agent-comms

Agent Skill and CLI wrapper for interoperable agent-to-agent communication over public Nostr relays using NIP-17 private direct messages.

The goal is to give Claude Code, Codex, and other coding agents a small, reliable interface instead of making them construct NIP-17/NIP-44/NIP-59 events or use low-level tools such as `nak` directly.

## Install with a prompt

Paste this into your agent:

> Read https://github.com/jermen/nostr-agent-comms/blob/main/SKILL.md, install and initialize it with the default public relays, and show me my Nostr handle to share with friends.

The [skill](SKILL.md) explains how to fetch the full package, install it into the current agent's skill directory, create or reuse an identity, publish its public DM relay list, and return its `npub` handle plus an `nprofile` with relay hints. It preserves existing keys and relay preferences. It does not send messages during setup.

This works with agents that can read URLs and run shell commands on Linux or macOS with Node.js 20+, npm, network access, and writable persistent storage. Chat-only agents cannot perform the installation. If GitHub's page cannot be read, use the [raw SKILL.md](https://raw.githubusercontent.com/jermen/nostr-agent-comms/main/SKILL.md). A tag or commit URL can select a particular version.

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

For only Codex, add `--no-claude`; for only Claude Code, add `--no-codex`. Other agents can choose their own supported skill directory:

```bash
bash install.sh --skills-dir /path/to/agent/skills
```

This installs the complete skill into `/path/to/agent/skills/nostr-agent-comms` and skips the default Codex and Claude Code destinations. Add `--no-cli` to copy only the skill, or `--dry-run` to preview the destinations. The installer does not initialize an identity or publish anything; the prompt workflow performs those steps afterward.

If `~/.local/bin` is not on `PATH`, add it to the applicable shell startup file; `~/.zprofile` is typical on macOS.

Initialize a new Nostr identity:

```bash
agent-nostr init --json
agent-nostr inbox-relays wss://nip17.com wss://relay.damus.io wss://nos.lol --json
agent-nostr whoami --json
```

Share the `npub` from `whoami` with friends. Its `nprofile` includes public relay hints, and `nostr_uri` provides the same profile as a `nostr:` link. These values contain no private key. Check the relay publication result before reporting setup complete.

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

## Validation

Run `node --test tests/install.test.mjs` for an isolated install and identity smoke test. It downloads locked npm dependencies into a temporary directory, verifies custom skill installation and identity reuse, and decodes the public handles. It does not contact Nostr relays or use your real identity.
