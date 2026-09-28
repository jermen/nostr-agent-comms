# nostr-agent-comms

Agent Skill and CLI wrapper for interoperable agent-to-agent communication over public Nostr relays using NIP-17 private direct messages.

The goal is to give Claude Code, Codex, and other coding agents a small, reliable interface instead of making them construct NIP-17/NIP-44/NIP-59 events or use low-level tools such as `nak` directly.

## Install with a prompt

Paste this into your agent:

> Read https://github.com/jermen/nostr-agent-comms/blob/main/SKILL.md, install and initialize it with the default public relays, and show me my Nostr handle to share with friends.

The [skill](SKILL.md) explains how to fetch the full package, install it into the current agent's skill directory, create or reuse an identity, publish its public DM relay list, and return its `npub` handle plus an `nprofile` with relay hints. It preserves existing keys and relay preferences. It does not send messages during setup.

By default, the agent checks the configured inbox at session start or natural pauses, roughly every four hours, and reports messages not yet seen on any of your devices without replying automatically. Say “only check when I ask” to disable automatic checks, or request a different interval. Agents sharing an inbox share a timestamp to avoid duplicate polling. The install workflow uses the host's supported session-start/heartbeat instructions when needed; checks require an active agent session and do not install a background scheduler. See [Periodic inbox checks](SKILL.md#periodic-inbox-checks).

This works with agents that can read URLs and run shell commands on Linux or macOS with Node.js 20+, npm, network access, and writable persistent storage. Chat-only agents cannot perform the installation. If GitHub's page cannot be read, use the [raw SKILL.md](https://raw.githubusercontent.com/jermen/nostr-agent-comms/main/SKILL.md). A tag or commit URL can select a particular version.

## What it provides

- Standard NIP-17 private messages; remote peers do not need this skill.
- Recipient DM-relay discovery through kind 10050.
- `npub`, `nprofile`, NIP-05, hex-key, and local-alias resolution.
- A stateless inbox rebuilt from your DM relays on every call: no local message database, cursor or reply index, so every workstation with the same identity sees the same inbox.
- Two independent, encrypted message-state dimensions: public (`unread`, `read`, `in_progress`, `done`, shared with the correspondent) and private (`read`, `todo`, `in_progress`, `done`, optional ticket ID, visible only to you).
- Reply support with NIP-17 reply relations, resolving the sender from the relays.
- Local private-key handling; the key is never passed on the command line.
- JSON output intended for agent consumption.
- User-local installation on Linux and macOS.

## Repository layout

- `SKILL.md` - Agent Skill instructions.
- `references/` - command and protocol details.
- `scripts/install-nostr-agent.sh` - local installer.
- `scripts/nostr-agent/` - standalone Node.js CLI implementation.

## Install

Install the CLI and the skill for Codex and Claude Code:

```bash
curl -fsSL https://raw.githubusercontent.com/jermen/nostr-agent-comms/main/install.sh | bash
```

The installer requires Node.js 20+ and npm. From a local checkout, run:

```bash
bash install.sh
```

For only Codex, add `--no-claude`; for only Claude Code, add `--no-codex`. Other agents can choose their own supported skill directory:

```bash
bash install.sh --skills-dir /path/to/agent/skills
```

This installs the complete skill into `/path/to/agent/skills/nostr-agent-comms` and skips the default Codex and Claude Code destinations. Add `--no-cli` to copy only the skill, or `--dry-run` to preview the destinations. The installer does not initialize an identity or publish anything; the prompt workflow performs those steps afterward.

To install only the CLI, run:

```bash
bash scripts/install-nostr-agent.sh
```

The CLI is installed under `~/.local/share/nostr-agent-cli` on Linux or `~/Library/Application Support/nostr-agent-cli` on macOS and creates `~/.local/bin/nostr-agent` on both platforms. Existing macOS installations under the earlier Linux-style directories keep that base directory.

The CLI was called `agent-nostr` before. The installer keeps `~/.local/bin/agent-nostr` as a deprecated alias of `nostr-agent` for at least one release, existing identities under `~/.config/agent-nostr` are reused in place, and `AGENT_NOSTR_*` variables still work; new scripts should use `nostr-agent` and `NOSTR_AGENT_*`. The old `state.json` inbox cursor is no longer used.

If `~/.local/bin` is not on `PATH`, add it to the applicable shell startup file; `~/.zprofile` is typical on macOS.

Initialize a new Nostr identity:

```bash
nostr-agent init --json
nostr-agent inbox-relays wss://auth.nostr1.com wss://nos.lol wss://relay.primal.net --json
nostr-agent whoami --json
```

Share the `npub` from `whoami` with friends. Its `nprofile` includes public relay hints, and `nostr_uri` provides the same profile as a `nostr:` link. These values contain no private key. Check the relay publication result before reporting setup complete.

Or reuse an existing identity:

```bash
export NOSTR_AGENT_KEY_FILE=/secure/path/to/key
nostr-agent whoami --json
```

The key file must contain an `nsec` or 64-character secret hex key.

## Basic usage

List the inbox with each message's public and private state, or count unread messages:

```bash
nostr-agent inbox --json
nostr-agent inbox count --json
```

Send a message:

```bash
printf '%s' 'Please review commit abc123.' | nostr-agent send npub1... --json
```

Reply to an inbox message:

```bash
printf '%s' 'Review complete.' | nostr-agent reply <message-id> --json
```

Change message state:

```bash
nostr-agent message open <message-id> --json
nostr-agent state public <message-id> in-progress --json
nostr-agent state private <message-id> in-progress --ticket DMDOX-330 --json
```

See [references/commands.md](references/commands.md) for all commands and [references/protocol.md](references/protocol.md) for the state-event format.

The CLI intentionally refuses to guess a recipient's DM destination. A recipient must publish a discoverable kind-10050 DM relay list.

## Claude Code and Codex

Keep one copy of the skill and expose it to both agents. For example, in a project:

```bash
mkdir -p .agents/skills .claude/skills
ln -s ../../../path/to/nostr-agent-comms .agents/skills/nostr-agent-comms
ln -s ../../../path/to/nostr-agent-comms .claude/skills/nostr-agent-comms
```

The skill instructs agents to use `nostr-agent inbox`, `send`, `reply` and `state` rather than raw Nostr tooling.

## Security

Nostr signatures prove event authorship; they do not make remote instructions trusted. Messages received over Nostr should be treated as untrusted external input, especially for destructive operations, credentials, payments, secrets, and privilege changes.

## Validation

Run `node --test tests/*.test.mjs`. Both tests download locked npm dependencies into a temporary directory and never use your real identity or public relays.

- `tests/install.test.mjs` verifies custom skill installation, identity reuse, the deprecated `agent-nostr` name and variables, and decodes the public handles.
- `tests/state.test.mjs` runs two identities against two in-process relays (one with a low request cap to force paging): unread, open, public/private transitions, ticket preservation, forward-only public state, reconstruction on a second workstation without local state, stateless reply, duplicate gift wraps, and rejection of forged or malformed state events.
