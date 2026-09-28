import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { startRelay } from './helpers/mini-relay.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))

// Two identities, A and B, on two local relays. Every CLI call is a fresh
// process, and no command may depend on or create local message state.
test('stateless inbox, public/private message state and reply', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nostr state test '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const cliDir = path.join(root, 'cli')
  const binDir = path.join(root, 'bin')
  const install = spawnSync('bash', [path.join(repo, 'scripts', 'install-nostr-agent.sh')], {
    env: { ...process.env, NOSTR_AGENT_INSTALL_DIR: cliDir, NOSTR_AGENT_BIN_DIR: binDir, npm_config_cache: path.join(root, 'npm cache') },
    encoding: 'utf8',
    timeout: 180000,
  })
  assert.equal(install.status, 0, install.stderr)

  const require = createRequire(path.join(cliDir, 'package.json'))
  const { WebSocketServer } = require('ws')
  const pure = require('nostr-tools/pure')
  const nip19 = require('nostr-tools/nip19')
  const nip44 = require('nostr-tools/nip44')
  const nip59 = require('nostr-tools/nip59')

  const relay1 = await startRelay({ WebSocketServer, verifyEvent: pure.verifyEvent })
  // A low request cap forces the CLI to page with 'until'.
  const relay2 = await startRelay({ WebSocketServer, verifyEvent: pure.verifyEvent, maxLimit: 3 })
  t.after(() => Promise.all([relay1.close(), relay2.close()]))

  function identityEnv(name) {
    return {
      ...process.env,
      NOSTR_AGENT_TEST_LOOPBACK_RELAYS: '1',
      NOSTR_AGENT_HOME: path.join(root, name),
      XDG_CONFIG_HOME: path.join(root, `${name} xdg config`),
      XDG_DATA_HOME: path.join(root, `${name} xdg data`),
      XDG_STATE_HOME: path.join(root, `${name} xdg state`),
    }
  }

  function run(name, args, { input = '', expected = 0 } = {}) {
    return new Promise((resolve, reject) => {
      // Asynchronous on purpose: the relays run in this process's event loop.
      const child = spawn(path.join(binDir, 'nostr-agent'), [...args, '--json'], { env: identityEnv(name) })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', reject)
      child.on('close', code => {
        try {
          assert.equal(code, expected, `${name} ${args.join(' ')}\n${stderr}`)
          resolve(JSON.parse(expected === 0 ? stdout : stderr))
        } catch (err) {
          reject(err)
        }
      })
      child.stdin.end(input)
    })
  }

  async function secretKey(name) {
    return nip19.decode((await fs.readFile(path.join(root, name, 'key'), 'utf8')).trim()).data
  }

  function injectWrap(wrap) {
    relay1.inject(wrap)
    relay2.inject(wrap)
  }

  const relays = [relay1.url, relay2.url]
  for (const name of ['a', 'b']) {
    await run(name, ['bootstrap-relays', ...relays])
    const init = await run(name, ['init', '--inbox', relay1.url, '--inbox', relay2.url])
    assert.equal(init.advertise.published_to.filter(r => r.ok).length, 2)
  }
  const a = await run('a', ['whoami'])
  const b = await run('b', ['whoami'])
  const find = (inbox, id) => inbox.messages.find(m => m.id === id)

  let messageId
  await t.test('1-2. B sees an unread message without any local state', async () => {
    const sent = await run('a', ['send', b.npub], { input: 'Restart db02' })
    messageId = sent.message_id
    const inbox = await run('b', ['inbox'])
    assert.equal(inbox.messages.length, 1)
    const message = inbox.messages[0]
    assert.equal(message.id, messageId)
    assert.equal(message.sender, a.pubkey)
    assert.equal(message.direction, 'in')
    assert.equal(message.content, 'Restart db02')
    assert.equal(message.public_state, 'unread')
    assert.equal(message.private_state, null)
    assert.equal(message.ticket_id, null)
    // The pasteable NIP-21 reference names the message, its author and kind 14.
    assert.match(message.ref, /^nostr:nevent1[02-9ac-hj-np-z]+$/)
    assert.deepEqual(nip19.decode(message.ref.slice(6)).data, { id: messageId, author: a.pubkey, kind: 14, relays: [] })
    assert.equal(sent.message_ref, message.ref)
    assert.equal((await run('b', ['inbox', 'count'])).count, 1)
  })

  await t.test('message references work wherever a message id does', async () => {
    const ref = find(await run('b', ['inbox']), messageId).ref
    for (const form of [ref, ref.slice(6), nip19.noteEncode(messageId), `nostr:${nip19.noteEncode(messageId)}`, messageId.toUpperCase()]) {
      assert.equal((await run('b', ['message', 'show', form])).message.id, messageId, form)
    }
    const invalid = await run('b', ['message', 'show', 'nostr:npub1invalid'], { expected: 1 })
    assert.match(invalid.error, /nevent1/)
    await run('b', ['message', 'show', `nostr:${b.npub}`], { expected: 1 })
  })

  await t.test('3. opening publishes public read to A and private read to B', async () => {
    const opened = await run('b', ['message', 'open', find(await run('b', ['inbox']), messageId).ref])
    assert.equal(opened.changed, true)
    assert.deepEqual(opened.updates.map(u => [u.scope, u.state]), [['public', 'read'], ['private', 'read']])
    assert.equal(opened.updates[0].correspondent.ok, true)
    assert.equal(opened.updates[1].correspondent, null)
    assert.equal(opened.message.public_state, 'read')
    assert.equal(opened.message.private_state, 'read')
    const sent = find(await run('a', ['inbox', '--all']), messageId)
    assert.equal(sent.direction, 'out')
    assert.equal(sent.public_state, 'read')
    assert.equal(sent.private_state, null)
    assert.equal((await run('b', ['inbox', 'count'])).count, 0)
    // Opening again never publishes a second time.
    assert.equal((await run('b', ['message', 'open', messageId])).changed, false)
  })

  await t.test('4. private todo is not sent to A', async () => {
    const wrapsForA = () => [...relay1.events.values()].filter(e => e.tags.some(t => t[0] === 'p' && t[1] === a.pubkey)).length
    const before = wrapsForA()
    const result = await run('b', ['state', 'private', messageId, 'todo'])
    assert.equal(result.state, 'todo')
    assert.equal(result.message.public_state, 'read')
    assert.equal(wrapsForA(), before)
    const sent = find(await run('a', ['inbox', '--all']), messageId)
    assert.equal(sent.private_state, null)
    assert.equal(sent.public_state, 'read')
  })

  await t.test('5. public in-progress reaches A without changing private state', async () => {
    const result = await run('b', ['state', 'public', messageId, 'in-progress'])
    assert.equal(result.state, 'in_progress')
    assert.equal(result.message.private_state, 'todo')
    assert.equal(find(await run('a', ['inbox', '--all']), messageId).public_state, 'in_progress')
  })

  await t.test('6-7. the ticket survives later private transitions until cleared', async () => {
    const ref = find(await run('b', ['inbox']), messageId).ref
    await run('b', ['state', 'private', ref.slice(6), 'in-progress', '--ticket', 'DMDOX-330'])
    let message = (await run('b', ['message', 'show', messageId])).message
    assert.equal(message.private_state, 'in_progress')
    assert.equal(message.ticket_id, 'DMDOX-330')
    assert.equal(message.public_state, 'in_progress')
    await run('b', ['state', 'private', messageId, 'done'])
    message = (await run('b', ['message', 'show', messageId])).message
    assert.equal(message.private_state, 'done')
    assert.equal(message.ticket_id, 'DMDOX-330')
  })

  await t.test('8. public done is forward-only', async () => {
    assert.equal((await run('b', ['state', 'public', messageId, 'done'])).message.public_state, 'done')
    const refused = await run('b', ['state', 'public', messageId, 'read'], { expected: 1 })
    assert.match(refused.error, /forward-only/)
    await run('b', ['state', 'public', messageId, 'unread'], { expected: 1 })
    await run('b', ['state', 'private', messageId, 'todo', '--ticket', 'X', '--clear-ticket'], { expected: 1 })
    await run('b', ['state', 'public', messageId, 'done', '--ticket', 'X'], { expected: 1 })
    assert.equal(find(await run('a', ['inbox', '--all']), messageId).public_state, 'done')
  })

  await t.test('9. a second workstation reconstructs the complete state', async () => {
    await fs.mkdir(path.join(root, 'b2'), { mode: 0o700 })
    for (const file of ['key', 'config.json']) {
      await fs.copyFile(path.join(root, 'b', file), path.join(root, 'b2', file))
      await fs.chmod(path.join(root, 'b2', file), 0o600)
    }
    const message = find(await run('b2', ['inbox']), messageId)
    assert.equal(message.public_state, 'done')
    assert.equal(message.private_state, 'done')
    assert.equal(message.ticket_id, 'DMDOX-330')
    assert.deepEqual((await fs.readdir(path.join(root, 'b'))).sort(), ['config.json', 'key'])
    for (const name of ['a', 'b', 'b2']) {
      for (const dir of ['xdg config', 'xdg data', 'xdg state']) {
        await assert.rejects(fs.access(path.join(root, `${name} ${dir}`)), `${name} ${dir} must not exist`)
      }
    }
  })

  await t.test('10. reply resolves the sender from the relays', async () => {
    const reply = await run('b2', ['reply', `nostr:${nip19.noteEncode(messageId)}`], { input: 'db02 restarted' })
    assert.equal(reply.to.pubkey, a.pubkey)
    assert.equal(reply.reply_to, messageId)
    const received = find(await run('a', ['inbox']), reply.message_id)
    assert.equal(received.reply_to, messageId)
    assert.equal(received.content, 'db02 restarted')
    assert.equal(received.sender, b.pubkey)
    const missing = await run('b', ['reply', 'f'.repeat(64)], { input: 'hello', expected: 1 })
    assert.match(missing.error, /not found/)
  })

  await t.test('11. duplicate wraps and relay copies do not duplicate messages', async () => {
    // A second, distinct gift wrap of the identical kind-14 rumor.
    const original = find(await run('b', ['inbox']), messageId)
    const skA = await secretKey('a')
    const rumor = nip59.createRumor({ kind: 14, created_at: original.created_at, content: original.content,
      tags: [['p', b.pubkey, relay1.url]] }, skA)
    assert.equal(rumor.id, messageId)
    injectWrap(nip59.createWrap(nip59.createSeal(rumor, skA, b.pubkey), b.pubkey))
    const inbox = await run('b', ['inbox'])
    assert.equal(inbox.messages.filter(m => m.id === messageId).length, 1)
    assert.equal(inbox.relay_status.length, 2)
    const [first, second] = inbox.relay_status
    assert.ok(first.ok && second.ok)
    assert.equal(first.events, second.events)
    assert.ok(second.pages > 2, `relay 2 should be paged, got ${second.pages}`)
    assert.equal(inbox.wrap_count, first.events)
  })

  await t.test('12. forged and malformed state events are ignored and reported', async () => {
    const target = (await run('a', ['send', b.npub], { input: 'Second request' })).message_id
    const skA = await secretKey('a')
    const skB = await secretKey('b')
    const skE = pure.generateSecretKey()
    const state = (id, scope, value, content = '') => ({
      kind: 78,
      created_at: Math.floor(Date.now() / 1000) + 60,
      tags: [['d', 'nostr-agent-message-state-v1'], ['e', id], ['scope', scope], ['state', value]],
      content,
    })
    const forged = [
      nip59.wrapEvent(state(target, 'public', 'done'), skE, b.pubkey),
      // The correspondent must not set the recipient's state.
      nip59.wrapEvent(state(target, 'public', 'done'), skA, b.pubkey),
      nip59.wrapEvent(state(target, 'private', 'archived'), skB, b.pubkey),
      nip59.wrapEvent(state(target, 'public', 'unread'), skB, b.pubkey),
      nip59.wrapEvent(state('not-a-hex-id', 'private', 'todo'), skB, b.pubkey),
      nip59.wrapEvent(state(target, 'private', 'todo', JSON.stringify({ ticket_id: 'T'.repeat(200) })), skB, b.pubkey),
    ]
    // Rumor claiming B as author, sealed by E: rejected by the seal check.
    const impostor = { ...state(target, 'private', 'done'), pubkey: pure.getPublicKey(skB) }
    impostor.id = pure.getEventHash(impostor)
    forged.push(nip59.createWrap(nip59.createSeal(impostor, skE, b.pubkey), b.pubkey))
    // Tampered rumor whose id no longer matches its content.
    const tampered = nip59.createRumor(state(target, 'private', 'done'), skB)
    tampered.tags = tampered.tags.map(t => (t[0] === 'state' ? ['state', 'todo'] : t))
    forged.push(nip59.createWrap(nip59.createSeal(tampered, skB, b.pubkey), b.pubkey))
    // A gift wrap that is not encrypted to B at all.
    forged.push(pure.finalizeEvent({ kind: 1059, created_at: 1, tags: [['p', b.pubkey]],
      content: nip44.encrypt('{}', nip44.getConversationKey(skE, pure.getPublicKey(skA))) }, skE))
    forged.forEach(injectWrap)

    const inbox = await run('b', ['inbox'])
    const message = find(inbox, target)
    assert.equal(message.public_state, 'unread')
    assert.equal(message.private_state, null)
    assert.equal(message.ticket_id, null)
    assert.equal(inbox.errors.length, forged.length, JSON.stringify(inbox.errors, null, 2))
    assert.equal(inbox.errors.filter(e => /unexpected author/.test(e.error)).length, 2)
    assert.equal((await run('b', ['inbox', 'count'])).count, 1)
    // The earlier message keeps its reconstructed state.
    assert.equal(find(inbox, messageId).public_state, 'done')
  })

  await t.test('private state can be reopened and the ticket cleared', async () => {
    const result = await run('b', ['state', 'private', messageId, 'todo', '--clear-ticket'])
    assert.equal(result.previous_state, 'done')
    assert.equal(result.previous_ticket_id, 'DMDOX-330')
    const message = (await run('b2', ['message', 'show', messageId])).message
    assert.equal(message.private_state, 'todo')
    assert.equal(message.ticket_id, null)
    assert.equal(message.public_state, 'done')
  })
})
