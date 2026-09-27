#!/usr/bin/env node

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import process from 'node:process'

const TOOL = 'nostr-agent'
const LEGACY_TOOL = 'agent-nostr'

const KIND_PROFILE = 0
const KIND_CHAT_MESSAGE = 14
const KIND_APP_DATA = 78
const KIND_GIFT_WRAP = 1059
const KIND_RELAY_LIST = 10002
const KIND_DM_RELAY_LIST = 10050
const MAX_DISCOVERY_RELAYS = 20
const MAX_REMOTE_DM_RELAYS = 10
const MAX_WRAP_CONTENT_CHARS = 512 * 1024
const MAX_INBOX_LIMIT = 5000
const RELAY_PAGE_LIMIT = 500
const MAX_RELAY_PAGES = 20

// Message state travels as NIP-78 kind-78 rumors inside NIP-59 gift wraps.
const STATE_D_TAG = 'nostr-agent-message-state-v1'
const PUBLIC_STATE_RANK = { unread: 0, read: 1, in_progress: 2, done: 3 }
// 'unread' is the absence of a public-state event, so it is never published.
const PUBLISHABLE_STATES = {
  public: ['read', 'in_progress', 'done'],
  private: ['read', 'todo', 'in_progress', 'done'],
}
const MAX_STATE_CONTENT_CHARS = 1024
const MAX_TICKET_CHARS = 64
const HEX64 = /^[0-9a-f]{64}$/

const DEFAULT_BOOTSTRAP_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
]

const DEFAULT_CONFIG = {
  bootstrap_relays: DEFAULT_BOOTSTRAP_RELAYS,
  inbox_relays: [],
  peers: {},
  query_timeout_ms: 6500,
  inbox_limit: 2000,
}

// Settings of the removed local inbox cursor; dropped on the next config save.
const LEGACY_CONFIG_KEYS = ['cursor_overlap_seconds', 'initial_lookback_seconds', 'max_seen_wraps', 'max_message_index']

// NOSTR_AGENT_* wins; the pre-rename AGENT_NOSTR_* names keep working.
function envSetting(name) {
  return process.env[`NOSTR_AGENT_${name}`] || process.env[`AGENT_NOSTR_${name}`] || undefined
}

const home = os.homedir()
const legacyConfigBase = path.join(home, '.config')
const macDataBase = path.join(home, 'Library', 'Application Support')

// An existing identity directory wins over the default, including one created
// under the pre-rename 'agent-nostr' name or the earlier macOS ~/.config location.
function defaultRootDir() {
  const bases = process.env.XDG_CONFIG_HOME
    ? [process.env.XDG_CONFIG_HOME]
    : process.platform === 'darwin' ? [macDataBase, legacyConfigBase] : [legacyConfigBase]
  const candidates = [TOOL, LEGACY_TOOL].flatMap(name => bases.map(base => path.join(base, name)))
  return candidates.find(dir => existsSync(dir)) || candidates[0]
}

const rootDir = envSetting('HOME') || defaultRootDir()
const configFile = envSetting('CONFIG') || path.join(rootDir, 'config.json')
const keyFile = envSetting('KEY_FILE') || path.join(rootDir, 'key')

// Test-only escape hatch for a local relay: also accepts ws:// on loopback hosts.
const ALLOW_LOOPBACK_RELAYS = process.env.NOSTR_AGENT_TEST_LOOPBACK_RELAYS === '1'

let JSON_MODE = false

function out(value) {
  if (JSON_MODE || typeof value !== 'string') console.log(JSON.stringify(value, null, JSON_MODE ? 2 : 0))
  else console.log(value)
}

function die(message, details = undefined, code = 1) {
  if (JSON_MODE) {
    console.error(JSON.stringify({ ok: false, error: message, ...(details === undefined ? {} : { details }) }, null, 2))
  } else {
    console.error(`${TOOL}: ${message}`)
    if (details !== undefined) console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2))
  }
  process.exit(code)
}

function usage() {
  return `${TOOL} - NIP-17 CLI for public-relay agent messaging

Usage:
  ${TOOL} init [--inbox RELAY ...] [--json]
  ${TOOL} whoami [--json]
  ${TOOL} bootstrap-relays RELAY... [--json]
  ${TOOL} inbox-relays RELAY... [--json]
  ${TOOL} advertise [--json]
  ${TOOL} peer add NAME TARGET [--json]
  ${TOOL} peer rm NAME [--json]
  ${TOOL} peer list [--json]
  ${TOOL} resolve TARGET [--json]
  ${TOOL} dm-relays TARGET [--json]
  ${TOOL} profile TARGET [--json]
  ${TOOL} send TARGET [MESSAGE...] [--reply-to EVENT_ID] [--json]
  ${TOOL} reply MESSAGE_ID [MESSAGE...] [--limit N] [--json]
  ${TOOL} inbox [--all] [--limit N] [--json]   (alias: check)
  ${TOOL} inbox count [--limit N] [--json]
  ${TOOL} message show MESSAGE_ID [--limit N] [--json]
  ${TOOL} message open MESSAGE_ID [--limit N] [--json]
  ${TOOL} state public MESSAGE_ID read|in-progress|done [--limit N] [--json]
  ${TOOL} state private MESSAGE_ID read|todo|in-progress|done
      [--ticket ID | --clear-ticket] [--limit N] [--json]
  ${TOOL} config [--json]
  ${TOOL} self-test

TARGET can be an npub, nprofile, 64-character hex pubkey, NIP-05 identifier,
or an alias configured with 'peer add'. If MESSAGE is omitted or is '-', stdin is read.
For send and reply, everything after '--' is literal message text, never options.

Inbox and message state:
  Every inbox, message, state and reply command rebuilds the inbox from your
  kind-10050 DM relays (up to --limit gift wraps per relay, default 2000).
  Nothing about messages is stored locally. Public state (unread, read,
  in-progress, done; forward-only) is sent encrypted to the correspondent and
  to yourself. Private state (read, todo, in-progress, done, optional ticket)
  is sent encrypted to yourself only. 'message open' marks an incoming message
  read in both dimensions without overwriting a more advanced state.

Security:
  The secret key is only read from NOSTR_AGENT_KEY_FILE or the ${TOOL} config
  directory (~/.config/${TOOL}/key on Linux, ~/Library/Application Support/
  ${TOOL}/key on macOS; an existing ${LEGACY_TOOL} directory is reused).
  No command prints the secret key.

Relay behavior:
  Sending strictly follows NIP-17: recipient kind-10050 DM relays are discovered
  first, and the gift wrap is published only to those relays. If none are found,
  send fails instead of guessing.
`
}

function consumeFlag(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

function consumeOption(args, name) {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  if (i + 1 >= args.length) die(`${name} requires a value`)
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}

function consumeRepeatedOption(args, name) {
  const values = []
  while (true) {
    const value = consumeOption(args, name)
    if (value === undefined) break
    values.push(value)
  }
  return values
}

function consumeLimit(args, config) {
  const raw = consumeOption(args, '--limit')
  const limit = raw === undefined ? config.inbox_limit : Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INBOX_LIMIT) die(`--limit must be an integer from 1 to ${MAX_INBOX_LIMIT}`)
  return limit
}

function isPrivateLiteralHost(hostname) {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const family = net.isIP(host)
  if (family === 4) {
    const parts = host.split('.').map(Number)
    const [a, b] = parts
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (family === 6) {
    return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') ||
      host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')
  }
  return false
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function normalizeRelay(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error(`invalid relay URL: ${input}`)
  }
  const testLoopback = ALLOW_LOOPBACK_RELAYS && (url.protocol === 'ws:' || url.protocol === 'wss:') && isLoopbackHost(url.hostname)
  if (!testLoopback) {
    if (url.protocol !== 'wss:') throw new Error(`public relay must use wss://: ${input}`)
    if (isPrivateLiteralHost(url.hostname)) throw new Error(`private or local relay address is not allowed in public-relay mode: ${input}`)
  }
  if (url.username || url.password) throw new Error(`relay URL must not contain credentials: ${input}`)
  url.hash = ''
  if (url.pathname === '/') url.pathname = ''
  return url.toString().replace(/\/$/, '')
}

function uniqueRelays(relays) {
  const result = []
  const seen = new Set()
  for (const relay of relays || []) {
    try {
      const value = normalizeRelay(relay)
      if (!seen.has(value)) {
        seen.add(value)
        result.push(value)
      }
    } catch {
      // Ignore malformed relay hints received from the network.
    }
  }
  return result
}

// Unlike uniqueRelays, user-supplied relay arguments must fail loudly:
// silently dropping a typo would publish an incomplete kind-10050 list.
function parseRelayArgs(inputs) {
  const result = []
  const seen = new Set()
  for (const input of inputs) {
    const value = normalizeRelay(input)
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

function mergeConfig(raw = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...raw,
    bootstrap_relays: uniqueRelays(raw.bootstrap_relays || DEFAULT_CONFIG.bootstrap_relays),
    inbox_relays: uniqueRelays(raw.inbox_relays || []),
    peers: raw.peers && typeof raw.peers === 'object' ? raw.peers : {},
  }
  if (!Number.isInteger(merged.inbox_limit) || merged.inbox_limit < 1 || merged.inbox_limit > MAX_INBOX_LIMIT) {
    merged.inbox_limit = DEFAULT_CONFIG.inbox_limit
  }
  for (const key of LEGACY_CONFIG_KEYS) delete merged[key]
  return merged
}

async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => {})
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback
    throw new Error(`cannot read ${file}: ${err.message}`)
  }
}

async function atomicJson(file, value, mode = 0o600) {
  await ensurePrivateDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await fs.rename(temp, file)
  await fs.chmod(file, mode).catch(() => {})
}

async function loadConfig() {
  return mergeConfig(await readJson(configFile, {}))
}

async function saveConfig(config) {
  await atomicJson(configFile, mergeConfig(config))
}

function hexToBytes(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('secret key hex must be exactly 64 hex characters')
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

async function loadNostr() {
  let poolMod, pure, nip19, nip59, wsMod
  try {
    ;[poolMod, pure, nip19, nip59, wsMod] = await Promise.all([
      import('nostr-tools/pool'),
      import('nostr-tools/pure'),
      import('nostr-tools/nip19'),
      import('nostr-tools/nip59'),
      import('ws'),
    ])
  } catch (err) {
    throw new Error(`missing runtime dependencies; run install-nostr-agent.sh (${err.message})`)
  }
  const BaseWebSocket = wsMod.default || wsMod.WebSocket || wsMod
  // nostr-tools drops its error handler when a connection attempt times out;
  // a late handshake failure (e.g. HTTP 502) would then crash the process.
  class WebSocketImpl extends BaseWebSocket {
    constructor(...args) {
      super(...args)
      this.on('error', () => {})
    }
  }
  poolMod.useWebSocketImplementation(WebSocketImpl)
  return { ...poolMod, pure, nip19, nip59 }
}

async function readSecretKey(nostr) {
  let text
  try {
    if (process.platform !== 'win32') {
      const stat = await fs.stat(keyFile)
      if (stat.mode & 0o077) {
        throw new Error(`refusing to use ${keyFile}: permissions are too open; run 'chmod 600' on it`)
      }
    }
    text = (await fs.readFile(keyFile, 'utf8')).trim()
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`no identity found; run '${TOOL} init' first`)
    throw err
  }
  if (text.startsWith('nsec1')) {
    const decoded = nostr.nip19.decode(text)
    if (decoded.type !== 'nsec') throw new Error('key file does not contain a valid nsec')
    return decoded.data
  }
  return hexToBytes(text)
}

async function writeSecretKey(nostr, sk) {
  await ensurePrivateDir(path.dirname(keyFile))
  await fs.writeFile(keyFile, `${nostr.nip19.nsecEncode(sk)}\n`, { mode: 0o600, flag: 'wx' })
  await fs.chmod(keyFile, 0o600).catch(() => {})
}

function authSigner(nostr, sk) {
  return async template => nostr.pure.finalizeEvent(template, sk)
}

function makePool(nostr) {
  return new nostr.SimplePool()
}

// nostr-tools retries after NIP-42 AUTH only when the reason starts with
// 'auth-required:'; relay.damus.io answers 'ERROR: auth-required: ...'.
function needsAuth(reason) {
  return /(^|\s)auth-required:/.test(String(reason || ''))
}

async function authenticate(nostr, pool, sk, url, timeoutMs) {
  const relay = await pool.ensureRelay(url, { connectionTimeout: timeoutMs })
  await relay.auth(authSigner(nostr, sk))
}

const EOSE_REASON = 'closed automatically on eose'

function subscribeEose(nostr, pool, sk, urls, filter, timeoutMs) {
  const started = Date.now()
  return new Promise(resolve => {
    const events = []
    pool.subscribeEose(urls, filter, {
      maxWait: timeoutMs,
      onauth: authSigner(nostr, sk),
      onevent(event) {
        events.push(event)
      },
      onclose(closes) {
        // nostr-tools reports its EOSE timeout exactly like a real EOSE. For a
        // single relay the elapsed time tells them apart; a relay that never
        // answers must not look like an empty inbox.
        if (urls.length === 1 && Date.now() - started >= timeoutMs - 50) {
          for (const item of closes) {
            if (item.reason === EOSE_REASON) item.reason = `no EOSE within ${timeoutMs} ms`
          }
        }
        resolve({ events, closes })
      },
    })
  })
}

async function queryWithAuth(nostr, pool, sk, relays, filter, timeoutMs) {
  const urls = uniqueRelays(relays)
  if (!urls.length) return { events: [], closes: [] }
  const first = await subscribeEose(nostr, pool, sk, urls, filter, timeoutMs)
  const retry = []
  await Promise.all(first.closes.filter(item => needsAuth(item.reason)).map(async item => {
    try {
      await authenticate(nostr, pool, sk, item.url, timeoutMs)
      retry.push(item.url)
    } catch (err) {
      item.reason = `${item.reason} (auth failed: ${err?.message || err})`
    }
  }))
  if (!retry.length) return first
  const second = await subscribeEose(nostr, pool, sk, retry, filter, timeoutMs)
  return {
    events: [...first.events, ...second.events],
    closes: [...first.closes.filter(item => !retry.includes(item.url)), ...second.closes],
  }
}


// EOSE_REASON is SimplePool's close reason for a subscription that reached
// EOSE; nostr-tools is pinned exactly because this string is internal.
function hadReadSuccess(queryResult) {
  return queryResult.closes.some(item => item.reason === EOSE_REASON)
}

async function publishWithAuth(nostr, pool, sk, relays, event, timeoutMs) {
  const publishOnce = async url => {
    const reason = await pool.publish([url], event, { maxWait: timeoutMs, onauth: authSigner(nostr, sk) })[0]
    return { url, ok: true, reason: String(reason || 'accepted') }
  }
  const urls = uniqueRelays(relays)
  const results = await Promise.all(
    urls.map(async url => {
      try {
        return await publishOnce(url)
      } catch (err) {
        if (!needsAuth(err?.message)) return { url, ok: false, reason: err?.message || String(err) }
        try {
          await authenticate(nostr, pool, sk, url, timeoutMs)
          return await publishOnce(url)
        } catch (retryErr) {
          return { url, ok: false, reason: retryErr?.message || String(retryErr) }
        }
      }
    }),
  )
  return results
}

function newestEvent(events, kind, author) {
  // NIP-01: among replaceable events with the same timestamp, the lowest id wins.
  return events
    .filter(e => e.kind === kind && (!author || e.pubkey === author))
    .sort((a, b) => b.created_at - a.created_at || String(a.id).localeCompare(String(b.id)))[0] || null
}

function relaysFrom10050(event) {
  if (!event) return []
  return uniqueRelays(event.tags.filter(t => t[0] === 'relay' && t[1]).map(t => t[1]))
}

function relaysFrom10002(event) {
  if (!event) return []
  return uniqueRelays(event.tags.filter(t => t[0] === 'r' && t[1]).map(t => t[1]))
}

function stripNostrPrefix(value) {
  return value.startsWith('nostr:') ? value.slice(6) : value
}

async function resolveNip05(input) {
  const at = input.lastIndexOf('@')
  if (at <= 0 || at === input.length - 1) throw new Error(`invalid NIP-05 identifier: ${input}`)
  const name = input.slice(0, at)
  const domain = input.slice(at + 1)
  if (isPrivateLiteralHost(domain.replace(/:\d+$/, ''))) {
    throw new Error(`NIP-05 domain is a private or local address: ${domain}`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`NIP-05 lookup returned HTTP ${response.status}`)
    const body = await response.json()
    const pubkey = body?.names?.[name]
    if (!/^[0-9a-fA-F]{64}$/.test(pubkey || '')) throw new Error(`NIP-05 name '${name}' not found at ${domain}`)
    return { pubkey: pubkey.toLowerCase(), relayHints: uniqueRelays(body?.relays?.[pubkey] || body?.relays?.[pubkey.toLowerCase()] || []) }
  } finally {
    clearTimeout(timer)
  }
}

async function resolveTarget(nostr, config, input, seenAliases = new Set()) {
  let value = stripNostrPrefix(String(input || '').trim())
  if (!value) throw new Error('empty target')

  if (config.peers[value]) {
    if (seenAliases.has(value)) throw new Error(`peer alias loop involving '${value}'`)
    seenAliases.add(value)
    const resolved = await resolveTarget(nostr, config, config.peers[value], seenAliases)
    return { ...resolved, alias: value, input }
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const pubkey = value.toLowerCase()
    return { input, pubkey, npub: nostr.nip19.npubEncode(pubkey), relayHints: [] }
  }

  if (value.includes('@') && !value.startsWith('nprofile1') && !value.startsWith('npub1')) {
    const nip05 = await resolveNip05(value)
    return { input, ...nip05, npub: nostr.nip19.npubEncode(nip05.pubkey), nip05: value }
  }

  try {
    const decoded = nostr.nip19.decode(value)
    if (decoded.type === 'npub') {
      return { input, pubkey: decoded.data, npub: value, relayHints: [] }
    }
    if (decoded.type === 'nprofile') {
      return {
        input,
        pubkey: decoded.data.pubkey,
        npub: nostr.nip19.npubEncode(decoded.data.pubkey),
        relayHints: uniqueRelays(decoded.data.relays || []),
      }
    }
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error(`cannot resolve target '${input}'; use npub, nprofile, hex pubkey, NIP-05, or a peer alias`)
}

async function discoverDmRelays(nostr, pool, sk, config, target) {
  const firstPass = uniqueRelays([...(target.relayHints || []), ...config.bootstrap_relays]).slice(0, MAX_DISCOVERY_RELAYS)
  const q1 = await queryWithAuth(nostr, pool, sk, firstPass, {
    kinds: [KIND_DM_RELAY_LIST],
    authors: [target.pubkey],
    limit: 20,
  }, config.query_timeout_ms)
  let event = newestEvent(q1.events, KIND_DM_RELAY_LIST, target.pubkey)
  let dmRelays = relaysFrom10050(event)
  if (dmRelays.length > MAX_REMOTE_DM_RELAYS) throw new Error(`recipient kind-10050 list contains ${dmRelays.length} relays; refusing an unreasonable remote relay list`)
  if (dmRelays.length) return { relays: dmRelays, event, searched: firstPass }

  const q2 = await queryWithAuth(nostr, pool, sk, firstPass, {
    kinds: [KIND_RELAY_LIST],
    authors: [target.pubkey],
    limit: 20,
  }, config.query_timeout_ms)
  if (!hadReadSuccess(q1) && !hadReadSuccess(q2)) {
    const err = new Error('could not read from any discovery relay while looking up the recipient')
    err.details = { relay_status: [...q1.closes, ...q2.closes] }
    throw err
  }
  const relayList = newestEvent(q2.events, KIND_RELAY_LIST, target.pubkey)
  const expanded = uniqueRelays([...firstPass, ...relaysFrom10002(relayList)]).slice(0, MAX_DISCOVERY_RELAYS)
  if (expanded.length > firstPass.length) {
    const q3 = await queryWithAuth(nostr, pool, sk, expanded, {
      kinds: [KIND_DM_RELAY_LIST],
      authors: [target.pubkey],
      limit: 20,
    }, config.query_timeout_ms)
    event = newestEvent(q3.events, KIND_DM_RELAY_LIST, target.pubkey)
    dmRelays = relaysFrom10050(event)
    if (dmRelays.length > MAX_REMOTE_DM_RELAYS) throw new Error(`recipient kind-10050 list contains ${dmRelays.length} relays; refusing an unreasonable remote relay list`)
  }
  return { relays: dmRelays, event, searched: expanded }
}

async function configuredOwnInbox(nostr, pool, sk, config, selfPubkey) {
  if (config.inbox_relays.length) return config.inbox_relays
  const target = { pubkey: selfPubkey, relayHints: [], npub: nostr.nip19.npubEncode(selfPubkey) }
  const discovered = await discoverDmRelays(nostr, pool, sk, config, target)
  return discovered.relays
}

async function advertiseInbox(nostr, pool, sk, config) {
  if (!config.inbox_relays.length) throw new Error(`no inbox relays configured; run '${TOOL} inbox-relays RELAY...'`)
  const event = nostr.pure.finalizeEvent({
    kind: KIND_DM_RELAY_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags: config.inbox_relays.map(relay => ['relay', relay]),
    content: '',
  }, sk)
  const destinations = uniqueRelays([...config.bootstrap_relays, ...config.inbox_relays])
  const results = await publishWithAuth(nostr, pool, sk, destinations, event, config.query_timeout_ms)
  if (!results.some(r => r.ok)) {
    const err = new Error('kind-10050 relay list was rejected or unreachable on every discovery relay')
    err.details = { published_to: results }
    throw err
  }
  return { event_id: event.id, inbox_relays: config.inbox_relays, published_to: results }
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text.replace(/\n$/, '')
}

function parseReplyTag(rumor) {
  const tag = rumor.tags?.find(t => t[0] === 'e' && t[1] && (t[3] === 'reply' || t.length <= 3))
  return tag?.[1] || null
}

function parseSubject(rumor) {
  return rumor.tags?.find(t => t[0] === 'subject' && t[1])?.[1] || null
}

function reversePeer(config, pubkey, nostr) {
  for (const [alias, target] of Object.entries(config.peers)) {
    try {
      const value = stripNostrPrefix(String(target))
      if (/^[0-9a-fA-F]{64}$/.test(value) && value.toLowerCase() === pubkey) return alias
      if (value.startsWith('npub1')) {
        const decoded = nostr.nip19.decode(value)
        if (decoded.type === 'npub' && decoded.data === pubkey) return alias
      }
      if (value.startsWith('nprofile1')) {
        const decoded = nostr.nip19.decode(value)
        if (decoded.type === 'nprofile' && decoded.data.pubkey === pubkey) return alias
      }
    } catch {
      // Alias display is best effort only.
    }
  }
  return null
}

function preview(value) {
  const text = String(value)
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}

function tagValues(rumor, name) {
  return rumor.tags.filter(t => t[0] === name).map(t => t[1])
}

function validateTicket(value) {
  if (typeof value !== 'string') throw new Error('ticket id must be a string')
  const ticket = value.trim()
  if (!ticket || [...ticket].length > MAX_TICKET_CHARS || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ticket)) {
    throw new Error(`ticket id must be 1-${MAX_TICKET_CHARS} printable characters`)
  }
  return ticket
}

function validateRumor(nostr, rumor) {
  if (!rumor || typeof rumor !== 'object') throw new Error('inner event is not an object')
  if (typeof rumor.pubkey !== 'string' || !HEX64.test(rumor.pubkey)) throw new Error('inner event has an invalid pubkey')
  if (!Number.isSafeInteger(rumor.created_at) || rumor.created_at < 0) throw new Error('inner event has an invalid created_at')
  if (!Number.isSafeInteger(rumor.kind)) throw new Error('inner event has an invalid kind')
  if (!Array.isArray(rumor.tags) || !rumor.tags.every(t => Array.isArray(t) && t.every(v => typeof v === 'string'))) {
    throw new Error('inner event has malformed tags')
  }
  if (typeof rumor.content !== 'string') throw new Error('inner event has non-string content')
  if (nostr.pure.getEventHash({
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    kind: rumor.kind,
    tags: rumor.tags,
    content: rumor.content,
  }) !== rumor.id) {
    throw new Error('inner rumor id does not match its event hash')
  }
}

function isStateRumor(rumor) {
  return rumor.kind === KIND_APP_DATA && tagValues(rumor, 'd').includes(STATE_D_TAG)
}

// Validates the schema of a kind-78 state rumor. Authorship is checked later,
// once the referenced message and its direction are known.
function parseStateRumor(rumor) {
  const single = name => {
    const values = tagValues(rumor, name)
    if (values.length !== 1 || typeof values[0] !== 'string') throw new Error(`state event needs exactly one '${name}' tag`)
    return values[0]
  }
  if (single('d') !== STATE_D_TAG) throw new Error('state event has an unexpected d tag')
  const messageId = single('e')
  if (!HEX64.test(messageId)) throw new Error('state event has an invalid message e tag')
  const scope = single('scope')
  if (!Object.hasOwn(PUBLISHABLE_STATES, scope)) throw new Error(`state event has unknown scope '${preview(scope)}'`)
  const state = single('state')
  if (!PUBLISHABLE_STATES[scope].includes(state)) throw new Error(`state event has unknown ${scope} state '${preview(state)}'`)
  if (rumor.content.length > MAX_STATE_CONTENT_CHARS) throw new Error('state event content is unreasonably large')
  let ticketId = null
  if (rumor.content) {
    let body
    try {
      body = JSON.parse(rumor.content)
    } catch {
      throw new Error('state event content is not JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('state event content is not a JSON object')
    if (body.ticket_id !== undefined && body.ticket_id !== null) {
      if (scope !== 'private') throw new Error('public state event must not carry a ticket')
      ticketId = validateTicket(body.ticket_id)
    }
  }
  return { id: rumor.id, author: rumor.pubkey, created_at: rumor.created_at, message_id: messageId, scope, state, ticket_id: ticketId }
}

// Newest inner created_at wins per (message, scope); equal timestamps fall back
// to the lowest event id, like NIP-01 replaceable events.
function newerState(current, candidate) {
  if (!current) return candidate
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at ? candidate : current
  return candidate.id < current.id ? candidate : current
}

// A user's own state events must be self-authored. The only foreign author
// accepted is a recipient reporting public state on a message we sent.
function stateAuthorAllowed(state, message, selfPubkey) {
  if (state.scope === 'private' || message.direction === 'in') return state.author === selfPubkey
  return state.author !== selfPubkey && message.recipients.includes(state.author)
}

function buildInbox(nostr, config, sk, selfPubkey, wraps) {
  const errors = []
  const rumors = new Map()
  for (const wrap of wraps) {
    let rumor
    try {
      if (typeof wrap.content !== 'string' || wrap.content.length > MAX_WRAP_CONTENT_CHARS) {
        throw new Error('gift wrap content is unreasonably large')
      }
      // Verifies the seal signature and that the rumor author matches the seal signer.
      rumor = nostr.nip59.unwrapEvent(wrap, sk)
      validateRumor(nostr, rumor)
    } catch (err) {
      errors.push({ wrap_id: wrap.id, error: err?.message || String(err) })
      continue
    }
    // The same rumor arrives in several wraps: one per relay copy, recipient and self-copy.
    if (!rumors.has(rumor.id)) rumors.set(rumor.id, { rumor, wrap_id: wrap.id })
  }

  const messages = new Map()
  const states = []
  for (const { rumor, wrap_id } of rumors.values()) {
    if (rumor.kind === KIND_CHAT_MESSAGE) {
      const sender = rumor.pubkey
      messages.set(rumor.id, {
        id: rumor.id,
        wrap_id,
        sender,
        sender_npub: nostr.nip19.npubEncode(sender),
        sender_alias: reversePeer(config, sender, nostr),
        recipients: [...new Set(tagValues(rumor, 'p').filter(p => typeof p === 'string' && HEX64.test(p)))],
        created_at: rumor.created_at,
        created_at_iso: new Date(rumor.created_at * 1000).toISOString(),
        reply_to: parseReplyTag(rumor),
        subject: parseSubject(rumor),
        content: rumor.content,
        direction: sender === selfPubkey ? 'out' : 'in',
        public_state: 'unread',
        public_state_at: null,
        private_state: null,
        private_state_at: null,
        ticket_id: null,
      })
    } else if (isStateRumor(rumor)) {
      try {
        states.push({ ...parseStateRumor(rumor), wrap_id })
      } catch (err) {
        errors.push({ wrap_id, event_id: rumor.id, error: err.message })
      }
    } else {
      errors.push({ wrap_id, error: `unsupported inner kind ${rumor.kind}` })
    }
  }

  const current = new Map()
  let orphanedStates = 0
  for (const state of states) {
    const message = messages.get(state.message_id)
    if (!message) {
      // Its message fell outside the fetched window or was never received.
      orphanedStates += 1
      continue
    }
    if (!stateAuthorAllowed(state, message, selfPubkey)) {
      errors.push({
        wrap_id: state.wrap_id,
        event_id: state.id,
        error: `${state.scope} state for message ${state.message_id} from unexpected author ${state.author}`,
      })
      continue
    }
    const key = `${state.message_id}:${state.scope}`
    current.set(key, newerState(current.get(key), state))
  }
  for (const state of current.values()) {
    const message = messages.get(state.message_id)
    if (state.scope === 'public') {
      message.public_state = state.state
      message.public_state_at = state.created_at
    } else {
      message.private_state = state.state
      message.private_state_at = state.created_at
      message.ticket_id = state.ticket_id
    }
  }

  // Inner kind-14 time, never the randomized gift-wrap time.
  const list = [...messages.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
  return { messages: list, errors, state_events: states.length, orphaned_states: orphanedStates }
}

// Pages through each relay separately with `until`, because relays cap the
// per-request limit (often at 100-500) below the requested inbox limit.
async function fetchRelayWraps(nostr, pool, sk, relay, selfPubkey, limit, timeoutMs, byId) {
  const seenHere = new Set()
  const status = { relay, ok: false, events: 0, pages: 0 }
  let until
  while (seenHere.size < limit && status.pages < MAX_RELAY_PAGES) {
    const filter = { kinds: [KIND_GIFT_WRAP], '#p': [selfPubkey], limit: Math.min(RELAY_PAGE_LIMIT, limit - seenHere.size) }
    if (until !== undefined) filter.until = until
    const q = await queryWithAuth(nostr, pool, sk, [relay], filter, timeoutMs)
    status.pages += 1
    if (!hadReadSuccess(q)) {
      status.error = q.closes.map(item => item.reason).filter(Boolean).join('; ') || 'no EOSE'
      break
    }
    status.ok = true
    let fresh = 0
    let oldest = Infinity
    for (const event of q.events) {
      if (event.kind !== KIND_GIFT_WRAP || typeof event.id !== 'string' || seenHere.has(event.id)) continue
      if (!event.tags?.some(t => t[0] === 'p' && t[1] === selfPubkey)) continue
      seenHere.add(event.id)
      fresh += 1
      oldest = Math.min(oldest, event.created_at)
      if (!byId.has(event.id)) byId.set(event.id, event)
    }
    if (!fresh) break
    // Inclusive bound: events sharing the boundary second are deduplicated above.
    until = oldest
  }
  status.events = seenHere.size
  status.truncated = seenHere.size >= limit
  return status
}

async function fetchGiftWraps(nostr, pool, sk, relays, selfPubkey, limit, timeoutMs) {
  const byId = new Map()
  const relayStatus = await Promise.all(
    uniqueRelays(relays).map(relay => fetchRelayWraps(nostr, pool, sk, relay, selfPubkey, limit, timeoutMs, byId)),
  )
  return { wraps: [...byId.values()], relayStatus }
}

async function loadInbox(ctx, limit) {
  const { nostr, pool, sk, config } = ctx
  const selfPubkey = nostr.pure.getPublicKey(sk)
  const ownInbox = await configuredOwnInbox(nostr, pool, sk, config, selfPubkey)
  if (!ownInbox.length) throw new Error(`no own kind-10050 DM relays found; configure them with '${TOOL} inbox-relays RELAY...'`)
  const { wraps, relayStatus } = await fetchGiftWraps(nostr, pool, sk, ownInbox, selfPubkey, limit, config.query_timeout_ms)
  if (!relayStatus.some(r => r.ok)) {
    const err = new Error('could not read from any configured DM inbox relay')
    err.details = { relay_status: relayStatus }
    throw err
  }
  return {
    selfPubkey,
    ownInbox,
    limit,
    truncated: relayStatus.some(r => r.truncated),
    wrap_count: wraps.length,
    relay_status: relayStatus,
    ...buildInbox(nostr, config, sk, selfPubkey, wraps),
  }
}

function parseMessageId(value) {
  const id = String(value || '').toLowerCase()
  if (!HEX64.test(id)) die(`message id must be a 64-character hex event id`)
  return id
}

function findMessage(inbox, messageId) {
  const message = inbox.messages.find(m => m.id === messageId)
  if (!message) {
    const err = new Error(`message ${messageId} was not found on your DM inbox relays (searched up to ${inbox.limit} gift wraps per relay)`)
    err.details = { relay_status: inbox.relay_status }
    throw err
  }
  return message
}

async function deliverToCorrespondent(ctx, pubkey, template) {
  const { nostr, pool, sk, config } = ctx
  try {
    const target = { pubkey, npub: nostr.nip19.npubEncode(pubkey), relayHints: [] }
    const discovered = await discoverDmRelays(nostr, pool, sk, config, target)
    if (!discovered.relays.length) {
      return { pubkey, ok: false, relays: [], error: 'correspondent has no discoverable kind-10050 DM relay list' }
    }
    const wrap = nostr.nip59.wrapEvent(template, sk, pubkey)
    const relays = await publishWithAuth(nostr, pool, sk, discovered.relays, wrap, config.query_timeout_ms)
    const ok = relays.some(r => r.ok)
    return { pubkey, ok, wrap_id: wrap.id, relays, ...(ok ? {} : { error: 'no correspondent DM relay accepted the gift wrap' }) }
  } catch (err) {
    return { pubkey, ok: false, relays: [], error: err?.message || String(err) }
  }
}

// Publishes one kind-78 rumor: public state to the correspondent plus a
// self-copy, private state only to ourselves. The inner rumor is never
// published unwrapped.
async function publishState(ctx, inbox, message, scope, state, ticketId) {
  const { nostr, pool, sk, config } = ctx
  const previousAt = scope === 'public' ? message.public_state_at : message.private_state_at
  // Keeps our own successive updates ordered even within the same second.
  const createdAt = Math.max(Math.floor(Date.now() / 1000), (previousAt || 0) + 1)
  const template = {
    kind: KIND_APP_DATA,
    created_at: createdAt,
    tags: [['d', STATE_D_TAG], ['e', message.id], ['scope', scope], ['state', state]],
    content: ticketId ? JSON.stringify({ ticket_id: ticketId }) : '',
  }
  const result = {
    event_id: nostr.pure.getEventHash({ ...template, pubkey: inbox.selfPubkey }),
    created_at: createdAt,
    correspondent: null,
    self_copy: null,
    warnings: [],
  }
  if (scope === 'public') {
    result.correspondent = await deliverToCorrespondent(ctx, message.sender, template)
    if (!result.correspondent.ok) {
      result.warnings.push(`public state was not delivered to the correspondent: ${result.correspondent.error}`)
    }
  }
  const selfWrap = nostr.nip59.wrapEvent(template, sk, inbox.selfPubkey)
  const relays = await publishWithAuth(nostr, pool, sk, inbox.ownInbox, selfWrap, config.query_timeout_ms)
  result.self_copy = { ok: relays.some(r => r.ok), wrap_id: selfWrap.id, relays }
  if (!result.self_copy.ok) {
    const err = new Error(`${scope} state was not accepted by any of your DM inbox relays`)
    err.details = result
    throw err
  }
  return result
}

async function changeState(ctx, inbox, message, scope, state, { ticket, clearTicket = false } = {}) {
  if (scope === 'public') {
    if (message.direction !== 'in') throw new Error('public state is set by the recipient; you sent this message')
    const previous = message.public_state
    if (PUBLIC_STATE_RANK[state] < PUBLIC_STATE_RANK[previous]) {
      throw new Error(`public state is forward-only: message is already ${previous}`)
    }
    const summary = { message_id: message.id, scope, previous_state: previous, state }
    if (state === previous) return { ...summary, changed: false }
    const published = await publishState(ctx, inbox, message, scope, state, null)
    message.public_state = state
    message.public_state_at = published.created_at
    return { ...summary, changed: true, ...published }
  }

  const previous = message.private_state
  const previousTicket = message.ticket_id
  // An existing ticket reference follows later transitions until cleared.
  const ticketId = clearTicket ? null : ticket ?? previousTicket
  const summary = { message_id: message.id, scope, previous_state: previous, state, previous_ticket_id: previousTicket, ticket_id: ticketId }
  if (state === previous && ticketId === previousTicket) return { ...summary, changed: false }
  const published = await publishState(ctx, inbox, message, scope, state, ticketId)
  message.private_state = state
  message.private_state_at = published.created_at
  message.ticket_id = ticketId
  return { ...summary, changed: true, ...published }
}

// The one convenience transition: opening an incoming message marks it read
// in both dimensions, but never overwrites a more advanced state.
async function openMessage(ctx, inbox, message) {
  const updates = []
  if (message.direction === 'in') {
    if (message.public_state === 'unread') updates.push(await changeState(ctx, inbox, message, 'public', 'read'))
    if (message.private_state === null) updates.push(await changeState(ctx, inbox, message, 'private', 'read'))
  }
  return {
    ok: true,
    message_id: message.id,
    changed: updates.some(u => u.changed),
    updates,
    warnings: updates.flatMap(u => u.warnings || []),
    message,
  }
}

async function sendMessage({ nostr, pool, sk, config, targetInput, message, replyTo = null, ownInbox = null }) {
  if (!message || !message.trim()) throw new Error('message is empty')
  if (Buffer.byteLength(message, 'utf8') > 64 * 1024) throw new Error('message is larger than 64 KiB')

  const selfPubkey = nostr.pure.getPublicKey(sk)
  const target = await resolveTarget(nostr, config, targetInput)
  const discovered = await discoverDmRelays(nostr, pool, sk, config, target)
  if (!discovered.relays.length) {
    throw new Error(`recipient has no discoverable kind-10050 DM relay list; NIP-17 says not to guess where to send`)
  }

  ownInbox = ownInbox || await configuredOwnInbox(nostr, pool, sk, config, selfPubkey)
  if (!ownInbox.length) {
    throw new Error(`your identity has no DM inbox relays; run '${TOOL} inbox-relays RELAY...' before sending`)
  }

  const chatTemplate = {
    kind: KIND_CHAT_MESSAGE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', target.pubkey, discovered.relays[0]]],
    content: message,
  }
  if (replyTo) chatTemplate.tags.push(['e', replyTo, '', 'reply'])
  const recipientWrap = nostr.nip59.wrapEvent(chatTemplate, sk, target.pubkey)
  const selfWrap = nostr.nip59.wrapEvent(chatTemplate, sk, selfPubkey)
  const messageId = nostr.pure.getEventHash({ ...chatTemplate, pubkey: selfPubkey })

  const recipientResults = await publishWithAuth(nostr, pool, sk, discovered.relays, recipientWrap, config.query_timeout_ms)
  if (!recipientResults.some(r => r.ok)) {
    const err = new Error('recipient gift wrap was not accepted by any of the recipient DM relays')
    err.details = { recipient_relays: recipientResults }
    throw err
  }
  const selfResults = await publishWithAuth(nostr, pool, sk, ownInbox, selfWrap, config.query_timeout_ms)

  return {
    ok: true,
    to: {
      input: targetInput,
      pubkey: target.pubkey,
      npub: target.npub,
      alias: target.alias || reversePeer(config, target.pubkey, nostr),
    },
    reply_to: replyTo,
    message_id: messageId,
    recipient_wrap_id: recipientWrap.id,
    recipient_relays: recipientResults,
    self_copy: {
      ok: selfResults.some(r => r.ok),
      wrap_id: selfWrap.id,
      relays: selfResults,
    },
  }
}

function publicIdentity(nostr, sk, config) {
  const pubkey = nostr.pure.getPublicKey(sk)
  const relays = uniqueRelays([...config.inbox_relays, ...config.bootstrap_relays]).slice(0, 3)
  const nprofile = nostr.nip19.nprofileEncode({ pubkey, relays })
  return {
    pubkey,
    npub: nostr.nip19.npubEncode(pubkey),
    nprofile,
    nostr_uri: `nostr:${nprofile}`,
    inbox_relays: config.inbox_relays,
  }
}

async function cmdInit(args) {
  const inbox = consumeRepeatedOption(args, '--inbox')
  if (args.length) die(`unexpected init arguments: ${args.join(' ')}`)
  const nostr = await loadNostr()
  const config = await loadConfig()
  await ensurePrivateDir(rootDir)
  let created = false
  try {
    await fs.access(keyFile)
  } catch {
    const sk = nostr.pure.generateSecretKey()
    await writeSecretKey(nostr, sk)
    created = true
  }
  const sk = await readSecretKey(nostr)
  if (inbox.length) config.inbox_relays = parseRelayArgs(inbox)
  await saveConfig(config)
  const result = {
    ok: true,
    created,
    ...publicIdentity(nostr, sk, config),
    config: configFile,
    key: keyFile,
  }
  if (inbox.length) {
    const pool = makePool(nostr)
    try {
      result.advertise = await advertiseInbox(nostr, pool, sk, config)
    } finally {
      pool.destroy()
    }
  }
  out(result)
}

async function withIdentity(fn) {
  const nostr = await loadNostr()
  const config = await loadConfig()
  const sk = await readSecretKey(nostr)
  const pool = makePool(nostr)
  try {
    return await fn({ nostr, config, sk, pool })
  } finally {
    pool.destroy()
  }
}

function selfTest() {
  const sample = {
    kind: KIND_DM_RELAY_LIST,
    tags: [['relay', 'wss://example.com/'], ['relay', 'wss://example.com'], ['x', 'ignored']],
  }
  const relays = relaysFrom10050(sample)
  if (relays.length !== 1 || relays[0] !== 'wss://example.com') throw new Error('relay normalization self-test failed')
  if (!ALLOW_LOOPBACK_RELAYS && uniqueRelays(['ws://example.com', 'wss://127.0.0.1', 'wss://user:pass@example.com']).length !== 0) {
    throw new Error('unsafe relay rejection self-test failed')
  }
  const older = { kind: KIND_DM_RELAY_LIST, pubkey: 'a', created_at: 1, id: '1' }
  const newer = { kind: KIND_DM_RELAY_LIST, pubkey: 'a', created_at: 2, id: '2' }
  if (newestEvent([older, newer], KIND_DM_RELAY_LIST, 'a')?.id !== '2') throw new Error('replaceable event selection self-test failed')

  const messageId = 'a'.repeat(64)
  const stateRumor = (tags, content = '') => ({
    id: 'b'.repeat(64), pubkey: 'c'.repeat(64), created_at: 10, kind: KIND_APP_DATA, content,
    tags: [['d', STATE_D_TAG], ...tags],
  })
  const parsed = parseStateRumor(stateRumor(
    [['e', messageId], ['scope', 'private'], ['state', 'in_progress']],
    JSON.stringify({ ticket_id: 'DMDOX-330' }),
  ))
  if (parsed.state !== 'in_progress' || parsed.ticket_id !== 'DMDOX-330') throw new Error('state parsing self-test failed')
  const malformed = [
    [['e', messageId], ['scope', 'shared'], ['state', 'read']],
    [['e', messageId], ['scope', 'public'], ['state', 'unread']],
    [['e', messageId], ['scope', 'private'], ['state', 'archived']],
    [['e', 'not-hex'], ['scope', 'public'], ['state', 'read']],
    [['scope', 'public'], ['state', 'read']],
    [['e', messageId], ['e', messageId], ['scope', 'public'], ['state', 'read']],
  ]
  for (const tags of malformed) {
    let rejected = false
    try { parseStateRumor(stateRumor(tags)) } catch { rejected = true }
    if (!rejected) throw new Error(`malformed state rejection self-test failed for ${JSON.stringify(tags)}`)
  }
  for (const content of ['x'.repeat(MAX_STATE_CONTENT_CHARS + 1), JSON.stringify({ ticket_id: 'T'.repeat(MAX_TICKET_CHARS + 1) })]) {
    let rejected = false
    try { parseStateRumor(stateRumor([['e', messageId], ['scope', 'private'], ['state', 'todo']], content)) } catch { rejected = true }
    if (!rejected) throw new Error('oversized state rejection self-test failed')
  }
  const a = { id: '2'.repeat(64), created_at: 5 }
  const b = { id: '1'.repeat(64), created_at: 5 }
  const c = { id: '3'.repeat(64), created_at: 6 }
  if (newerState(newerState(a, b), c) !== c || newerState(a, b) !== b) throw new Error('state folding self-test failed')
  out({
    ok: true,
    tests: ['relay-normalization', 'unsafe-relay-rejection', 'newest-replaceable-event',
      'state-parsing', 'malformed-state-rejection', 'oversized-state-rejection', 'state-folding'],
  })
}

async function main() {
  const args = process.argv.slice(2)
  // Everything after '--' is literal message text for send/reply, never options.
  let literalArgs = []
  const separator = args.indexOf('--')
  if (separator !== -1) {
    literalArgs = args.slice(separator + 1)
    args.length = separator
  }
  JSON_MODE = consumeFlag(args, '--json')
  const command = args.shift()
  if (literalArgs.length && command !== 'send' && command !== 'reply') {
    die(`unexpected arguments after --: ${literalArgs.join(' ')}`)
  }
  // JSON consumers parse stderr, so the rename notice is for humans only.
  if (!JSON_MODE && path.basename(process.argv[1] || '') === LEGACY_TOOL) {
    console.error(`${LEGACY_TOOL} is deprecated; use ${TOOL}`)
  }

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage())
    return
  }

  if (command === 'self-test') return selfTest()

  if (command === 'init') return await cmdInit(args)

  if (command === 'config') {
    if (args.length) die(`unexpected arguments: ${args.join(' ')}`)
    const config = await loadConfig()
    out({ ok: true, config_file: configFile, key_file: keyFile, config })
    return
  }

  if (command === 'reset-cursor') {
    if (args.length) die(`unexpected arguments: ${args.join(' ')}`)
    out({ ok: true, deprecated: true, note: 'the inbox is rebuilt from relays and has no local cursor; nothing to reset' })
    return
  }

  if (command === 'bootstrap-relays') {
    if (!args.length) die('provide at least one relay URL')
    const config = await loadConfig()
    config.bootstrap_relays = parseRelayArgs(args)
    await saveConfig(config)
    out({ ok: true, bootstrap_relays: config.bootstrap_relays })
    return
  }

  if (command === 'peer') {
    const action = args.shift()
    const config = await loadConfig()
    if (action === 'list') {
      if (args.length) die(`unexpected arguments: ${args.join(' ')}`)
      out({ ok: true, peers: config.peers })
      return
    }
    if (action === 'add') {
      const name = args.shift()
      const target = args.shift()
      if (!name || !target || args.length) die(`usage: ${TOOL} peer add NAME TARGET`)
      if (!/^[A-Za-z0-9._-]+$/.test(name)) die('peer alias may only contain letters, numbers, dot, underscore, and dash')
      // Aliases resolve before keys, so a key-shaped alias would shadow the real key.
      if (/^[0-9a-fA-F]{64}$/.test(name) || /^(npub|nprofile|nsec)1/i.test(name)) {
        die('peer alias must not look like a hex key or bech32 identifier; pick a short name')
      }
      config.peers[name] = target
      await saveConfig(config)
      out({ ok: true, alias: name, target })
      return
    }
    if (action === 'rm' || action === 'remove') {
      const name = args.shift()
      if (!name || args.length) die(`usage: ${TOOL} peer rm NAME`)
      delete config.peers[name]
      await saveConfig(config)
      out({ ok: true, removed: name })
      return
    }
    die(`usage: ${TOOL} peer {add|rm|list} ...`)
  }

  await withIdentity(async ctx => {
    const { nostr, config, sk, pool } = ctx

    if (command === 'whoami') {
      if (args.length) die(`unexpected arguments: ${args.join(' ')}`)
      out({ ok: true, ...publicIdentity(nostr, sk, config) })
      return
    }

    if (command === 'inbox-relays') {
      if (!args.length) die('provide 1-3 public DM relay URLs')
      const relays = parseRelayArgs(args)
      if (relays.length > 3) die('NIP-17 recommends keeping the DM relay list to 1-3 relays')
      config.inbox_relays = relays
      await saveConfig(config)
      const advertised = await advertiseInbox(nostr, pool, sk, config)
      out({ ok: true, ...advertised })
      return
    }

    if (command === 'advertise') {
      if (args.length) die(`unexpected arguments: ${args.join(' ')}`)
      out({ ok: true, ...(await advertiseInbox(nostr, pool, sk, config)) })
      return
    }

    if (command === 'resolve' || command === 'dm-relays') {
      const input = args.shift()
      if (!input || args.length) die(`usage: ${TOOL} ${command} TARGET`)
      const target = await resolveTarget(nostr, config, input)
      const result = { ok: true, target }
      if (command === 'dm-relays') {
        const discovered = await discoverDmRelays(nostr, pool, sk, config, target)
        result.dm_relays = discovered.relays
        result.kind_10050_event_id = discovered.event?.id || null
        result.searched = discovered.searched
      }
      out(result)
      return
    }

    if (command === 'profile') {
      const input = args.shift()
      if (!input || args.length) die(`usage: ${TOOL} profile TARGET`)
      const target = await resolveTarget(nostr, config, input)
      const relays = uniqueRelays([...(target.relayHints || []), ...config.bootstrap_relays])
      const q = await queryWithAuth(nostr, pool, sk, relays, { kinds: [KIND_PROFILE], authors: [target.pubkey], limit: 20 }, config.query_timeout_ms)
      const event = newestEvent(q.events, KIND_PROFILE, target.pubkey)
      let profile = null
      if (event) {
        try { profile = JSON.parse(event.content) } catch { profile = { raw: event.content } }
      }
      out({ ok: true, target, profile, event_id: event?.id || null })
      return
    }

    if (command === 'send') {
      const replyTo = consumeOption(args, '--reply-to')
      const target = args.shift()
      if (!target) die(`usage: ${TOOL} send TARGET [MESSAGE...]`)
      let message = [...args, ...literalArgs].join(' ')
      if (!message || message === '-') message = await readStdin()
      const result = await sendMessage({ nostr, pool, sk, config, targetInput: target, message, replyTo: replyTo || null })
      out(result)
      return
    }

    if (command === 'reply') {
      const limit = consumeLimit(args, config)
      const eventId = args.shift()
      if (!eventId) die(`usage: ${TOOL} reply MESSAGE_ID [MESSAGE...]`)
      const messageId = parseMessageId(eventId)
      let message = [...args, ...literalArgs].join(' ')
      if (!message || message === '-') message = await readStdin()
      if (!message.trim()) throw new Error('message is empty')
      // The sender comes from the message itself on the relays, never from a local index.
      const inbox = await loadInbox(ctx, limit)
      const original = findMessage(inbox, messageId)
      const target = original.direction === 'in'
        ? original.sender
        : original.recipients.find(pubkey => pubkey !== inbox.selfPubkey)
      if (!target) throw new Error(`message ${messageId} names no recipient to reply to`)
      out(await sendMessage({ nostr, pool, sk, config, targetInput: target, message, replyTo: original.id, ownInbox: inbox.ownInbox }))
      return
    }

    if (command === 'inbox' || command === 'check') {
      const count = args[0] === 'count'
      if (count) args.shift()
      const all = consumeFlag(args, '--all')
      const limit = consumeLimit(args, config)
      if (args.length) die(`unexpected inbox arguments: ${args.join(' ')}`)
      if (count && all) die('--all does not apply to inbox count')
      const inbox = await loadInbox(ctx, limit)
      const incoming = inbox.messages.filter(m => m.direction === 'in')
      if (count) {
        const unread = incoming.filter(m => m.public_state === 'unread').length
        if (!JSON_MODE) {
          out(String(unread))
          return
        }
        out({
          ok: true,
          count: unread,
          incoming: incoming.length,
          truncated: inbox.truncated,
          errors: inbox.errors.length,
          relay_status: inbox.relay_status,
        })
        return
      }
      out({
        ok: true,
        inbox_relays: inbox.ownInbox,
        limit: inbox.limit,
        truncated: inbox.truncated,
        wrap_count: inbox.wrap_count,
        messages: all ? inbox.messages : incoming,
        errors: inbox.errors,
        state_events: inbox.state_events,
        orphaned_states: inbox.orphaned_states,
        relay_status: inbox.relay_status,
      })
      return
    }

    if (command === 'message') {
      const action = args.shift()
      if (action !== 'show' && action !== 'open') die(`usage: ${TOOL} message {show|open} MESSAGE_ID`)
      const limit = consumeLimit(args, config)
      const [eventId, ...rest] = args
      if (!eventId || rest.length) die(`usage: ${TOOL} message ${action} MESSAGE_ID`)
      const messageId = parseMessageId(eventId)
      const inbox = await loadInbox(ctx, limit)
      const message = findMessage(inbox, messageId)
      out(action === 'show' ? { ok: true, message } : await openMessage(ctx, inbox, message))
      return
    }

    if (command === 'state') {
      const scope = args.shift()
      const stateUsage = `usage: ${TOOL} state public MESSAGE_ID read|in-progress|done\n` +
        `       ${TOOL} state private MESSAGE_ID read|todo|in-progress|done [--ticket ID | --clear-ticket]`
      if (scope !== 'public' && scope !== 'private') die(stateUsage)
      const ticketOption = consumeOption(args, '--ticket')
      const clearTicket = consumeFlag(args, '--clear-ticket')
      const limit = consumeLimit(args, config)
      const [eventId, stateArg, ...rest] = args
      if (!eventId || !stateArg || rest.length) die(stateUsage)
      const messageId = parseMessageId(eventId)
      // The CLI spells states with '-', the wire format with '_'.
      const state = stateArg.replace(/-/g, '_')
      if (!PUBLISHABLE_STATES[scope].includes(state)) {
        die(`unknown ${scope} state '${stateArg}'; use ${PUBLISHABLE_STATES[scope].map(s => s.replace(/_/g, '-')).join(', ')}`)
      }
      if (scope === 'public' && (ticketOption !== undefined || clearTicket)) die('--ticket and --clear-ticket apply only to private state')
      if (ticketOption !== undefined && clearTicket) die('use either --ticket or --clear-ticket, not both')
      let ticket
      if (ticketOption !== undefined) {
        try { ticket = validateTicket(ticketOption) } catch (err) { die(err.message) }
      }
      const inbox = await loadInbox(ctx, limit)
      const message = findMessage(inbox, messageId)
      const result = await changeState(ctx, inbox, message, scope, state, { ticket, clearTicket })
      out({ ok: true, ...result, message })
      return
    }

    die(`unknown command '${command}'\n\n${usage()}`)
  })
}

main().then(
  // Exit once stdout is flushed: a relay handshake that is still pending must
  // not keep the process alive after the answer.
  () => process.stdout.write('', () => process.exit(process.exitCode ?? 0)),
  err => die(err?.message || String(err), err?.details),
)
