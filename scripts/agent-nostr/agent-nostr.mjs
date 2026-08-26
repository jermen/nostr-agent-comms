#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import process from 'node:process'

const KIND_PROFILE = 0
const KIND_RELAY_LIST = 10002
const KIND_DM_RELAY_LIST = 10050
const KIND_GIFT_WRAP = 1059
const KIND_CHAT_MESSAGE = 14
const MAX_DISCOVERY_RELAYS = 20
const MAX_REMOTE_DM_RELAYS = 10
const MAX_WRAP_CONTENT_CHARS = 512 * 1024

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
  cursor_overlap_seconds: 3 * 24 * 60 * 60,
  initial_lookback_seconds: 14 * 24 * 60 * 60,
  max_seen_wraps: 10000,
  max_message_index: 2000,
}

const home = os.homedir()
const configBase = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
const dataBase = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
const rootDir = process.env.AGENT_NOSTR_HOME || path.join(configBase, 'agent-nostr')
const configFile = process.env.AGENT_NOSTR_CONFIG || path.join(rootDir, 'config.json')
const keyFile = process.env.AGENT_NOSTR_KEY_FILE || path.join(rootDir, 'key')
const stateFile = process.env.AGENT_NOSTR_STATE || path.join(dataBase, 'agent-nostr', 'state.json')

let JSON_MODE = false

function out(value) {
  if (JSON_MODE || typeof value !== 'string') console.log(JSON.stringify(value, null, JSON_MODE ? 2 : 0))
  else console.log(value)
}

function die(message, details = undefined, code = 1) {
  if (JSON_MODE) {
    console.error(JSON.stringify({ ok: false, error: message, ...(details === undefined ? {} : { details }) }, null, 2))
  } else {
    console.error(`agent-nostr: ${message}`)
    if (details !== undefined) console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2))
  }
  process.exit(code)
}

function usage() {
  return `agent-nostr - NIP-17 CLI for public-relay agent messaging

Usage:
  agent-nostr init [--inbox RELAY ...] [--json]
  agent-nostr whoami [--json]
  agent-nostr bootstrap-relays RELAY... [--json]
  agent-nostr inbox-relays RELAY... [--json]
  agent-nostr advertise [--json]
  agent-nostr peer add NAME TARGET [--json]
  agent-nostr peer rm NAME [--json]
  agent-nostr peer list [--json]
  agent-nostr resolve TARGET [--json]
  agent-nostr dm-relays TARGET [--json]
  agent-nostr profile TARGET [--json]
  agent-nostr send TARGET [MESSAGE...] [--reply-to EVENT_ID] [--json]
  agent-nostr reply EVENT_ID [MESSAGE...] [--json]
  agent-nostr inbox [--all] [--limit N] [--json]
  agent-nostr reset-cursor [--json]
  agent-nostr config [--json]
  agent-nostr self-test

TARGET can be an npub, nprofile, 64-character hex pubkey, NIP-05 identifier,
or an alias configured with 'peer add'. If MESSAGE is omitted or is '-', stdin is read.

Security:
  The secret key is only read from AGENT_NOSTR_KEY_FILE or ~/.config/agent-nostr/key.
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

function normalizeRelay(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error(`invalid relay URL: ${input}`)
  }
  if (url.protocol !== 'wss:') throw new Error(`public relay must use wss://: ${input}`)
  if (url.username || url.password) throw new Error(`relay URL must not contain credentials: ${input}`)
  if (isPrivateLiteralHost(url.hostname)) throw new Error(`private or local relay address is not allowed in public-relay mode: ${input}`)
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

function mergeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    bootstrap_relays: uniqueRelays(raw.bootstrap_relays || DEFAULT_CONFIG.bootstrap_relays),
    inbox_relays: uniqueRelays(raw.inbox_relays || []),
    peers: raw.peers && typeof raw.peers === 'object' ? raw.peers : {},
  }
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

function emptyState() {
  return { last_check: 0, seen_wrap_ids: [], messages: {} }
}

async function loadState() {
  const raw = await readJson(stateFile, emptyState())
  return {
    last_check: Number.isFinite(raw.last_check) ? raw.last_check : 0,
    seen_wrap_ids: Array.isArray(raw.seen_wrap_ids) ? raw.seen_wrap_ids.filter(x => typeof x === 'string') : [],
    messages: raw.messages && typeof raw.messages === 'object' ? raw.messages : {},
  }
}

async function saveState(state, config) {
  const seen = state.seen_wrap_ids.slice(-config.max_seen_wraps)
  const entries = Object.entries(state.messages)
  const messages = Object.fromEntries(entries.slice(-config.max_message_index))
  await atomicJson(stateFile, { ...state, seen_wrap_ids: seen, messages })
}

function hexToBytes(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('secret key hex must be exactly 64 hex characters')
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

async function loadNostr() {
  let poolMod, pure, nip17, nip19, nip59, wsMod
  try {
    ;[poolMod, pure, nip17, nip19, nip59, wsMod] = await Promise.all([
      import('nostr-tools/pool'),
      import('nostr-tools/pure'),
      import('nostr-tools/nip17'),
      import('nostr-tools/nip19'),
      import('nostr-tools/nip59'),
      import('ws'),
    ])
  } catch (err) {
    throw new Error(`missing runtime dependencies; run install-agent-nostr.sh (${err.message})`)
  }
  const WebSocketImpl = wsMod.default || wsMod.WebSocket || wsMod
  poolMod.useWebSocketImplementation(WebSocketImpl)
  return { ...poolMod, pure, nip17, nip19, nip59 }
}

async function readSecretKey(nostr) {
  let text
  try {
    text = (await fs.readFile(keyFile, 'utf8')).trim()
  } catch (err) {
    if (err?.code === 'ENOENT') throw new Error(`no identity found; run 'agent-nostr init' first`)
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
  const pool = new nostr.SimplePool()
  pool.trackRelays = true
  return pool
}

async function queryWithAuth(nostr, pool, sk, relays, filter, timeoutMs) {
  const urls = uniqueRelays(relays)
  if (!urls.length) return { events: [], closes: [] }
  return await new Promise(resolve => {
    const events = []
    pool.subscribeEose(urls, filter, {
      maxWait: timeoutMs,
      onauth: authSigner(nostr, sk),
      onevent(event) {
        events.push(event)
      },
      onclose(closes) {
        resolve({ events, closes })
      },
    })
  })
}


function hadReadSuccess(queryResult) {
  return queryResult.closes.some(item => item.reason === 'closed automatically on eose')
}

async function publishWithAuth(nostr, pool, sk, relays, event, timeoutMs) {
  const urls = uniqueRelays(relays)
  const results = await Promise.all(
    urls.map(async url => {
      try {
        const promise = pool.publish([url], event, { maxWait: timeoutMs, onauth: authSigner(nostr, sk) })[0]
        const reason = await promise
        return { url, ok: true, reason: String(reason || 'accepted') }
      } catch (err) {
        return { url, ok: false, reason: err?.message || String(err) }
      }
    }),
  )
  return results
}

function newestEvent(events, kind, author) {
  return events
    .filter(e => e.kind === kind && (!author || e.pubkey === author))
    .sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(String(a.id)))[0] || null
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
    throw new Error('could not read from any discovery relay while looking up the recipient')
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
  if (!config.inbox_relays.length) throw new Error(`no inbox relays configured; run 'agent-nostr inbox-relays RELAY...'`)
  const event = nostr.pure.finalizeEvent({
    kind: KIND_DM_RELAY_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags: config.inbox_relays.map(relay => ['relay', relay]),
    content: '',
  }, sk)
  const destinations = uniqueRelays([...config.bootstrap_relays, ...config.inbox_relays])
  const results = await publishWithAuth(nostr, pool, sk, destinations, event, config.query_timeout_ms)
  if (!results.some(r => r.ok)) throw new Error('kind-10050 relay list was rejected or unreachable on every discovery relay')
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

async function sendMessage({ nostr, pool, sk, config, targetInput, message, replyTo = null }) {
  if (!message || !message.trim()) throw new Error('message is empty')
  if (Buffer.byteLength(message, 'utf8') > 64 * 1024) throw new Error('message is larger than 64 KiB')

  const selfPubkey = nostr.pure.getPublicKey(sk)
  const target = await resolveTarget(nostr, config, targetInput)
  const discovered = await discoverDmRelays(nostr, pool, sk, config, target)
  if (!discovered.relays.length) {
    throw new Error(`recipient has no discoverable kind-10050 DM relay list; NIP-17 says not to guess where to send`)
  }

  const ownInbox = await configuredOwnInbox(nostr, pool, sk, config, selfPubkey)
  if (!ownInbox.length) {
    throw new Error(`your identity has no DM inbox relays; run 'agent-nostr inbox-relays RELAY...' before sending`)
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
  const selfResults = await publishWithAuth(nostr, pool, sk, ownInbox, selfWrap, config.query_timeout_ms)
  if (!recipientResults.some(r => r.ok)) throw new Error('recipient gift wrap was not accepted by any of the recipient DM relays')

  return {
    ok: true,
    to: { input: targetInput, pubkey: target.pubkey, npub: target.npub, alias: target.alias || null },
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
  if (inbox.length) config.inbox_relays = uniqueRelays(inbox)
  await saveConfig(config)
  const result = {
    ok: true,
    created,
    pubkey: nostr.pure.getPublicKey(sk),
    npub: nostr.nip19.npubEncode(nostr.pure.getPublicKey(sk)),
    config: configFile,
    key: keyFile,
    inbox_relays: config.inbox_relays,
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

async function main() {
  const args = process.argv.slice(2)
  JSON_MODE = consumeFlag(args, '--json')
  const command = args.shift()

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage())
    return
  }

  if (command === 'self-test') {
    const sample = {
      kind: KIND_DM_RELAY_LIST,
      tags: [['relay', 'wss://example.com/'], ['relay', 'wss://example.com'], ['x', 'ignored']],
    }
    const relays = relaysFrom10050(sample)
    if (relays.length !== 1 || relays[0] !== 'wss://example.com') throw new Error('relay normalization self-test failed')
    if (uniqueRelays(['ws://example.com', 'wss://127.0.0.1', 'wss://user:pass@example.com']).length !== 0) {
      throw new Error('unsafe relay rejection self-test failed')
    }
    const older = { kind: KIND_DM_RELAY_LIST, pubkey: 'a', created_at: 1, id: '1' }
    const newer = { kind: KIND_DM_RELAY_LIST, pubkey: 'a', created_at: 2, id: '2' }
    if (newestEvent([older, newer], KIND_DM_RELAY_LIST, 'a')?.id !== '2') throw new Error('replaceable event selection self-test failed')
    out({ ok: true, tests: ['relay-normalization', 'unsafe-relay-rejection', 'newest-replaceable-event'] })
    return
  }

  if (command === 'init') return await cmdInit(args)

  if (command === 'config') {
    if (args.length) die(`unexpected arguments: ${args.join(' ')}`)
    const config = await loadConfig()
    out({ ok: true, config_file: configFile, key_file: keyFile, state_file: stateFile, config })
    return
  }

  if (command === 'reset-cursor') {
    if (args.length) die(`unexpected arguments: ${args.join(' ')}`)
    const config = await loadConfig()
    await saveState(emptyState(), config)
    out({ ok: true, state_file: stateFile })
    return
  }

  if (command === 'bootstrap-relays') {
    if (!args.length) die('provide at least one relay URL')
    const config = await loadConfig()
    config.bootstrap_relays = uniqueRelays(args)
    if (!config.bootstrap_relays.length) die('no valid relay URLs supplied')
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
      if (!name || !target || args.length) die(`usage: agent-nostr peer add NAME TARGET`)
      if (!/^[A-Za-z0-9._-]+$/.test(name)) die('peer alias may only contain letters, numbers, dot, underscore, and dash')
      config.peers[name] = target
      await saveConfig(config)
      out({ ok: true, alias: name, target })
      return
    }
    if (action === 'rm' || action === 'remove') {
      const name = args.shift()
      if (!name || args.length) die(`usage: agent-nostr peer rm NAME`)
      delete config.peers[name]
      await saveConfig(config)
      out({ ok: true, removed: name })
      return
    }
    die(`usage: agent-nostr peer {add|rm|list} ...`)
  }

  await withIdentity(async ({ nostr, config, sk, pool }) => {
    const selfPubkey = nostr.pure.getPublicKey(sk)

    if (command === 'whoami') {
      if (args.length) die(`unexpected arguments: ${args.join(' ')}`)
      out({ ok: true, pubkey: selfPubkey, npub: nostr.nip19.npubEncode(selfPubkey), inbox_relays: config.inbox_relays })
      return
    }

    if (command === 'inbox-relays') {
      if (!args.length) die('provide 1-3 public DM relay URLs')
      const relays = uniqueRelays(args)
      if (!relays.length) die('no valid relay URLs supplied')
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
      if (!input || args.length) die(`usage: agent-nostr ${command} TARGET`)
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
      if (!input || args.length) die(`usage: agent-nostr profile TARGET`)
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
      if (!target) die(`usage: agent-nostr send TARGET [MESSAGE...]`)
      let message = args.join(' ')
      if (!message || message === '-') message = await readStdin()
      const result = await sendMessage({ nostr, pool, sk, config, targetInput: target, message, replyTo: replyTo || null })
      out(result)
      return
    }

    if (command === 'reply') {
      const eventId = args.shift()
      if (!eventId) die(`usage: agent-nostr reply EVENT_ID [MESSAGE...]`)
      let message = args.join(' ')
      if (!message || message === '-') message = await readStdin()
      const state = await loadState()
      const indexed = state.messages[eventId]
      if (!indexed?.sender) throw new Error(`message ${eventId} is not in the local inbox index; run 'agent-nostr inbox --all' first`)
      const result = await sendMessage({ nostr, pool, sk, config, targetInput: indexed.sender, message, replyTo: eventId })
      out(result)
      return
    }

    if (command === 'inbox' || command === 'check') {
      const all = consumeFlag(args, '--all')
      const limitRaw = consumeOption(args, '--limit')
      const limit = limitRaw === undefined ? 500 : Number.parseInt(limitRaw, 10)
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) die('--limit must be an integer from 1 to 5000')
      if (args.length) die(`unexpected inbox arguments: ${args.join(' ')}`)

      const ownInbox = await configuredOwnInbox(nostr, pool, sk, config, selfPubkey)
      if (!ownInbox.length) throw new Error(`no own kind-10050 DM relays found; configure them with 'agent-nostr inbox-relays RELAY...'`)
      const state = await loadState()
      const now = Math.floor(Date.now() / 1000)
      const filter = { kinds: [KIND_GIFT_WRAP], '#p': [selfPubkey], limit }
      if (!all) {
        filter.since = state.last_check
          ? Math.max(0, state.last_check - config.cursor_overlap_seconds)
          : Math.max(0, now - config.initial_lookback_seconds)
      }
      const q = await queryWithAuth(nostr, pool, sk, ownInbox, filter, config.query_timeout_ms)
      if (!hadReadSuccess(q)) throw new Error('could not read from any configured DM inbox relay; cursor was not advanced')
      const seen = new Set(state.seen_wrap_ids)
      const wraps = q.events.filter(e => all || !seen.has(e.id))
      const messages = []
      const errors = []

      for (const wrap of wraps) {
        try {
          if (typeof wrap.content !== 'string' || wrap.content.length > MAX_WRAP_CONTENT_CHARS) {
            throw new Error('gift wrap content is unreasonably large')
          }
          const rumor = nostr.nip17.unwrapEvent(wrap, sk)
          if (rumor.kind !== KIND_CHAT_MESSAGE) {
            errors.push({ wrap_id: wrap.id, error: `unsupported inner kind ${rumor.kind}` })
            seen.add(wrap.id)
            continue
          }
          if (nostr.pure.getEventHash({
            pubkey: rumor.pubkey,
            created_at: rumor.created_at,
            kind: rumor.kind,
            tags: rumor.tags,
            content: rumor.content,
          }) !== rumor.id) {
            throw new Error('inner rumor id does not match its event hash')
          }
          const sender = rumor.pubkey
          const item = {
            id: rumor.id,
            wrap_id: wrap.id,
            sender,
            sender_npub: nostr.nip19.npubEncode(sender),
            sender_alias: reversePeer(config, sender, nostr),
            created_at: rumor.created_at,
            created_at_iso: new Date(rumor.created_at * 1000).toISOString(),
            reply_to: parseReplyTag(rumor),
            subject: parseSubject(rumor),
            content: rumor.content,
          }
          state.messages[rumor.id] = { sender, created_at: rumor.created_at, wrap_id: wrap.id }
          if (sender !== selfPubkey || all) messages.push({ ...item, direction: sender === selfPubkey ? 'out' : 'in' })
          seen.add(wrap.id)
        } catch (err) {
          errors.push({ wrap_id: wrap.id, error: err?.message || String(err) })
          seen.add(wrap.id)
        }
      }

      messages.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      state.last_check = now
      state.seen_wrap_ids = [...seen]
      await saveState(state, config)
      out({
        ok: true,
        inbox_relays: ownInbox,
        since: filter.since || null,
        messages,
        errors,
        relay_status: q.closes,
      })
      return
    }

    die(`unknown command '${command}'\n\n${usage()}`)
  })
}

main().catch(err => die(err?.message || String(err)))
