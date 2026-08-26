# agent-nostr command reference

## Install

From the skill directory:

```bash
bash scripts/install-agent-nostr.sh
```

The installer copies the CLI to `~/.local/share/agent-nostr-cli`, installs pinned npm dependencies there, and creates `~/.local/bin/agent-nostr`.

## Identity setup

Create an identity without publishing anything:

```bash
agent-nostr init --json
```

The private key is created at `~/.config/agent-nostr/key` with mode 0600. Never print, cat, copy into prompts, or pass it as a command-line argument.

To reuse an existing identity, point the wrapper at an existing mode-0600 key file containing an `nsec` or 64-character secret hex value:

```bash
export AGENT_NOSTR_KEY_FILE=/secure/path/to/agent-nostr-key
agent-nostr whoami --json
```

Do not ask the user to paste an `nsec` into the agent conversation.

Configure 1-3 public NIP-17 inbox relays and publish kind 10050:

```bash
agent-nostr inbox-relays \
  wss://nip17.com \
  wss://relay.damus.io \
  wss://nos.lol \
  --json
```

Relay services can change policy or availability. The above are examples, not a guarantee. Replace them when the user already has preferred public DM relays. Public-relay mode accepts only `wss://` relay URLs.

Republish the same kind-10050 list:

```bash
agent-nostr advertise --json
```

Show the public identity:

```bash
agent-nostr whoami --json
```

## Address book

```bash
agent-nostr peer add codex npub1... --json
agent-nostr peer add alice alice@example.com --json
agent-nostr peer list --json
agent-nostr peer rm codex --json
```

Aliases are local conveniences only.

## Inspect a recipient

```bash
agent-nostr resolve npub1... --json
agent-nostr profile npub1... --json
agent-nostr dm-relays npub1... --json
```

`dm-relays` is the quickest diagnostic when sending fails.

## Send

Prefer stdin for arbitrary text because it avoids shell-quoting mistakes:

```bash
printf '%s' 'Please review commit abc123 and tell me what you find.' \
  | agent-nostr send codex --json
```

A direct argument also works:

```bash
agent-nostr send codex 'Ping' --json
```

The wrapper discovers the recipient kind-10050 list on every invocation. It will not guess a relay when the recipient has no discoverable list.

## Check inbox

Return only messages not previously processed by this wrapper:

```bash
agent-nostr inbox --json
```

Query a larger relay-side history and rebuild the local reply index:

```bash
agent-nostr inbox --all --limit 2000 --json
```

Do not infer chronology from gift-wrap timestamps. The CLI returns the inner kind-14 message timestamp as `created_at`.

## Reply

After `inbox`, use the message's `id`:

```bash
printf '%s' 'Done. I found two issues.' \
  | agent-nostr reply <message-id> --json
```

This resolves the sender from the local inbox index and creates the NIP-17 `e` reply tag.

## Discovery relays

The default bootstrap list is used only to find profiles, NIP-65 relay lists, and NIP-17 kind-10050 relay lists:

```bash
agent-nostr bootstrap-relays \
  wss://purplepag.es \
  wss://relay.damus.io \
  wss://relay.primal.net \
  wss://nos.lol \
  --json
```

Changing bootstrap relays does not change the recipient's DM destination.

## Diagnostics

```bash
agent-nostr config --json
agent-nostr self-test
agent-nostr reset-cursor --json
```

`reset-cursor` forgets the local seen-message state; it does not delete anything from Nostr relays.
