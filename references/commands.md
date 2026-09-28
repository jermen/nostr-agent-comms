# nostr-agent command reference

## Install

For installation directly from a GitHub `SKILL.md` URL, follow [the skill's bootstrap workflow](../SKILL.md#install-from-this-url). It downloads the full package and selects the current agent's installation directory. `bash install.sh --skills-dir DIR` installs the CLI and the full skill at `DIR/nostr-agent-comms`; add `--no-cli` to copy only the skill.

The installer requires Node.js 20 or newer with npm. It does not install system packages. On macOS, install Node.js separately first if needed, for example with Homebrew or a user-scoped version manager.

From the skill directory:

```bash
bash scripts/install-nostr-agent.sh
```

The default CLI locations are:

- Linux: `~/.local/share/nostr-agent-cli`
- macOS: `~/Library/Application Support/nostr-agent-cli`

On both platforms the installer creates `~/.local/bin/nostr-agent`, and `~/.local/bin/agent-nostr` as a deprecated alias of the same CLI for existing scripts. If that directory is not on `PATH`, add this to the applicable shell startup file (`~/.zprofile` is typical for macOS):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Use `NOSTR_AGENT_INSTALL_DIR` or `NOSTR_AGENT_BIN_DIR` to override either destination; the older `AGENT_NOSTR_*` names are still accepted. `XDG_DATA_HOME` overrides the platform-specific default data directory.

On macOS, an existing installation under `~/.local/share` keeps that base directory, so upgrading does not strand the previous installation. A previous `agent-nostr-cli` installation directory is no longer used after upgrading and can be removed.

## Identity setup

Create an identity without publishing anything:

```bash
nostr-agent init --json
```

The private key is created with mode 0600 at `~/.config/nostr-agent/key` on Linux or `~/Library/Application Support/nostr-agent/key` on macOS. `XDG_CONFIG_HOME` overrides these defaults. An existing identity directory from before the rename (`agent-nostr` under the same locations, or the earlier macOS `~/.config` location) is reused automatically; nothing is moved. Never print, cat, copy into prompts, or pass the key as a command-line argument.

To reuse an existing identity, point the wrapper at an existing mode-0600 key file containing an `nsec` or 64-character secret hex value:

```bash
export NOSTR_AGENT_KEY_FILE=/secure/path/to/nostr-agent-key
nostr-agent whoami --json
```

`NOSTR_AGENT_HOME` and `NOSTR_AGENT_CONFIG` select the identity directory and config file; each also has a deprecated `AGENT_NOSTR_*` spelling.

Both `init` and `whoami` return `npub`, `nprofile`, and `nostr_uri`. Share `npub` as the stable handle; `nprofile` embeds up to three configured inbox/discovery relay hints and `nostr_uri` is `nostr:<nprofile>`. These are public values. `init` without `--inbox` preserves an existing identity and relay configuration and does not publish anything. Neither command's public identity output proves relay reachability.

Do not ask the user to paste an `nsec` into the agent conversation.

Configure 1-3 public NIP-17 inbox relays and publish kind 10050:

```bash
nostr-agent inbox-relays \
  wss://auth.nostr1.com \
  wss://nos.lol \
  wss://relay.primal.net \
  --json
```

Relay services can change policy or availability. The above are examples, not a guarantee. They were chosen on 2026-09-28 by a round trip with throwaway keys (publish a gift wrap, read it back as the recipient): `auth.nostr1.com` serves kind 1059 only to the NIP-42-authenticated recipient, while `nos.lol` and `relay.primal.net` let anyone list the gift wraps addressed to a key (contents stay encrypted, but who receives how many messages and when does not). `relay.damus.io` (NIP-42 AUTH broken on the relay side) and `nip17.com` (no answer after AUTH) failed and should not be used as DM inbox relays. Replace them when the user already has preferred public DM relays. Public-relay mode accepts only `wss://` relay URLs. Use more than one inbox relay: they are the only store of your messages and message state.

Republish the same kind-10050 list:

```bash
nostr-agent advertise --json
```

Show the public identity:

```bash
nostr-agent whoami --json
```

## Address book

```bash
nostr-agent peer add codex npub1... --json
nostr-agent peer add alice alice@example.com --json
nostr-agent peer list --json
nostr-agent peer rm codex --json
```

Aliases are local conveniences only.

## Inspect a recipient

```bash
nostr-agent resolve npub1... --json
nostr-agent profile npub1... --json
nostr-agent dm-relays npub1... --json
```

`dm-relays` is the quickest diagnostic when sending fails.

## Send

Prefer stdin for arbitrary text because it avoids shell-quoting mistakes:

```bash
printf '%s' 'Please review commit abc123 and tell me what you find.' \
  | nostr-agent send codex --json
```

A direct argument also works:

```bash
nostr-agent send codex 'Ping' --json
```

The wrapper discovers the recipient kind-10050 list on every invocation. It will not guess a relay when the recipient has no discoverable list.

## Check inbox

Return every incoming message retrievable from your DM inbox relays, with its current state:

```bash
nostr-agent inbox --json
```

Nothing is stored locally: each call fetches the kind-1059 gift wraps addressed to you, deduplicates them, unwraps them, and folds the message-state events. A fresh process or another workstation with the same identity and relay configuration returns the same result. There is no cursor to reset; `reset-cursor` is a deprecated no-op.

Each message includes:

```json
{
  "id": "<inner kind-14 event id>",
  "ref": "nostr:nevent1...",
  "sender": "<hex pubkey>",
  "sender_npub": "npub1...",
  "sender_alias": "codex",
  "recipients": ["<hex pubkey>"],
  "created_at": 1790000000,
  "created_at_iso": "2026-09-21T12:53:20.000Z",
  "reply_to": null,
  "subject": null,
  "content": "...",
  "direction": "in",
  "public_state": "unread",
  "public_state_at": null,
  "private_state": null,
  "private_state_at": null,
  "ticket_id": null
}
```

`created_at` is the inner kind-14 timestamp; the list is sorted by it, never by randomized gift-wrap times. The result also reports `errors` (undecryptable, malformed, forged or unsupported events, which never change state), `relay_status` per relay, `wrap_count`, `state_events`, `orphaned_states` (state for messages outside the fetched window), and `truncated`.

Include your own sent messages; their `public_state` is what the recipient reported:

```bash
nostr-agent inbox --all --json
```

Count incoming messages whose public state is `unread` (plain number without `--json`):

```bash
nostr-agent inbox count --json
```

Show one message, incoming or sent:

```bash
nostr-agent message show <message-id> --json
```

## Message references

`ref` is a NIP-21 URI (`nostr:nevent1…`) that encodes the message id, its author and kind 14, without relay hints: the inner message is only retrievable from your own inbox. It is meant for prompts and notes, e.g. "Process message nostr:nevent1…". Wherever a command takes `<message-id>` (`message`, `state`, `reply`, `send --reply-to`), it also accepts the ref, the bare `nevent1…`, a `note1…` or the hex id. `send` and `reply` return the new message's `message_ref`.

Link a ticket created for a message:

```bash
nostr-agent state private nostr:nevent1... in-progress --ticket DMDOX-337 --json
```

`inbox`, `message`, `state` and `reply` accept `--limit N` (1-5000): the maximum number of gift wraps fetched per relay, default 2000 or the config's `inbox_limit`. State events count against the limit too. Relays are paged, so a relay cap below the limit does not truncate the result.

## Message state

Public state is shared with the correspondent, encrypted: `unread` (no event), `read`, `in_progress`, `done`. It only moves forward; a request to go back fails and repeating the current state publishes nothing.

```bash
nostr-agent state public <message-id> read --json
nostr-agent state public <message-id> in-progress --json
nostr-agent state public <message-id> done --json
```

Private state is visible only to you: `read`, `todo`, `in_progress`, `done`, optionally with an opaque ticket reference that later private transitions keep until cleared. It may move backwards.

```bash
nostr-agent state private <message-id> read --json
nostr-agent state private <message-id> todo --json
nostr-agent state private <message-id> in-progress --json
nostr-agent state private <message-id> in-progress --ticket DMDOX-330 --json
nostr-agent state private <message-id> done --json
nostr-agent state private <message-id> todo --clear-ticket --json
```

The CLI accepts `in-progress` (or `in_progress`); JSON and the wire format use `in_progress`. Private and public state never change each other. The result reports `previous_state`, `state`, `changed`, the published `event_id`, relay results for `self_copy` and, for public state, `correspondent`, plus the updated `message`. If the correspondent has no discoverable DM relays or none accepts the event, the self-copy is still published and `warnings` explains it. Relay acceptance does not prove the correspondent read the update.

Open an incoming message: publish public `read` if it is `unread`, and private `read` if it has no private state. More advanced states are never overwritten, and opening an already read message publishes nothing:

```bash
nostr-agent message open <message-id> --json
```

## Reply

Use the message's `id`:

```bash
printf '%s' 'Done. I found two issues.' \
  | nostr-agent reply <message-id> --json
```

The original message is fetched from your DM inbox relays; its sender (or, for your own sent message, its recipient) becomes the reply target, and the NIP-17 `e` reply tag is added. If the message can no longer be retrieved, `reply` fails instead of guessing.

## Discovery relays

The default bootstrap list is used only to find profiles, NIP-65 relay lists, and NIP-17 kind-10050 relay lists:

```bash
nostr-agent bootstrap-relays \
  wss://purplepag.es \
  wss://relay.damus.io \
  wss://relay.primal.net \
  wss://nos.lol \
  --json
```

Changing bootstrap relays does not change the recipient's DM destination.

## Diagnostics

```bash
nostr-agent config --json
nostr-agent self-test
```

`config` shows the config and key file paths and settings, never the key. A `state.json` left by `agent-nostr` versions before the rename is no longer read or written and can be deleted.
