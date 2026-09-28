import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = fileURLToPath(new URL('..', import.meta.url))

test('portable installation and public identity handoff', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nostr install test '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const skills = path.join(root, 'custom skills')
  const skill = path.join(skills, 'nostr-agent-comms')
  const cliDir = path.join(root, 'cli data')
  const identity = path.join(root, 'identity')
  const env = {
    ...process.env,
    NOSTR_AGENT_INSTALL_DIR: cliDir,
    NOSTR_AGENT_BIN_DIR: path.join(root, 'bin'),
    NOSTR_AGENT_HOME: identity,
    NOSTR_AGENT_KEY_FILE: path.join(identity, 'key'),
    NOSTR_AGENT_CONFIG: path.join(identity, 'config.json'),
    XDG_DATA_HOME: path.join(root, 'xdg data'),
    CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    npm_config_cache: path.join(root, 'npm cache'),
  }
  function run(command, args, cwd = repo, expected = 0) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000 })
    assert.equal(result.status, expected, result.stderr)
    return result.stdout
  }
  const cli = (...args) => JSON.parse(run(path.join(env.NOSTR_AGENT_BIN_DIR, 'nostr-agent'), [...args, '--json']))
  const exists = async p => fs.access(p).then(() => true, () => false)

  await t.test('dry run and missing argument do not create destinations', async () => {
    run('bash', ['install.sh', '--skills-dir', skills, '--dry-run'])
    assert.equal(await exists(skills), false)
    assert.equal(await exists(cliDir), false)
    run('bash', ['install.sh', '--skills-dir'], repo, 2)
  })

  await t.test('skill-only install carries everything needed to install again', async () => {
    run('bash', ['install.sh', '--skills-dir', skills, '--no-cli'])
    for (const file of ['SKILL.md', 'install.sh', 'agents/openai.yaml', 'references/commands.md',
      'references/protocol.md', 'scripts/install-nostr-agent.sh', 'scripts/nostr-agent/nostr-agent.mjs',
      'scripts/nostr-agent/package.json', 'scripts/nostr-agent/package-lock.json']) {
      assert.equal(await exists(path.join(skill, file)), true, file)
    }
    assert.equal(await exists(cliDir), false)
    assert.equal(await exists(env.CODEX_HOME), false)
    assert.equal(await exists(env.CLAUDE_CONFIG_DIR), false)
    assert.equal(await exists(identity), false)
  })

  await t.test('CLI installs from the copied skill without the repository', async () => {
    run('bash', ['install.sh', '--skills-dir', skills], skill)
    assert.equal(await exists(path.join(env.NOSTR_AGENT_BIN_DIR, 'nostr-agent')), true)
    assert.equal(await exists(path.join(env.NOSTR_AGENT_BIN_DIR, 'agent-nostr')), true)
    assert.equal(await exists(identity), false)
    assert.equal(await exists(env.CODEX_HOME), false)
    assert.equal(await exists(env.CLAUDE_CONFIG_DIR), false)
  })

  await t.test('initialization returns decodable public handles and preserves identity on repeat', async () => {
    const { decode } = createRequire(path.join(cliDir, 'package.json'))('nostr-tools/nip19')
    const first = cli('init')
    assert.equal(first.created, true)
    assert.deepEqual(first.inbox_relays, [])
    const config = JSON.parse(await fs.readFile(env.NOSTR_AGENT_CONFIG, 'utf8'))
    config.inbox_relays = ['wss://example.com', 'wss://relay.example.com']
    await fs.writeFile(env.NOSTR_AGENT_CONFIG, JSON.stringify(config))
    const second = cli('init')
    const publicInfo = cli('whoami')
    assert.equal(second.created, false)
    assert.equal(second.npub, first.npub)
    assert.equal(publicInfo.npub, first.npub)
    assert.deepEqual(publicInfo.inbox_relays, config.inbox_relays)
    assert.deepEqual(decode(publicInfo.npub), { type: 'npub', data: publicInfo.pubkey })
    const profile = decode(publicInfo.nprofile)
    assert.equal(profile.type, 'nprofile')
    assert.equal(profile.data.pubkey, publicInfo.pubkey)
    assert.deepEqual(profile.data.relays.slice(0, 2), config.inbox_relays)
    assert.equal(profile.data.relays.length, 3)
    assert.equal(publicInfo.nostr_uri, `nostr:${publicInfo.nprofile}`)
    assert.deepEqual(Object.keys(publicInfo).sort(), ['ok', 'pubkey', 'npub', 'nprofile', 'nostr_uri', 'inbox_relays'].sort())
    assert.equal((await fs.stat(env.NOSTR_AGENT_KEY_FILE)).mode & 0o777, 0o600)
    assert.equal(await exists(env.XDG_DATA_HOME), false)
  })

  await t.test('deprecated agent-nostr name and AGENT_NOSTR_* variables still work', async () => {
    const expected = cli('whoami').npub
    const legacyEnv = { ...env, AGENT_NOSTR_HOME: identity, AGENT_NOSTR_KEY_FILE: env.NOSTR_AGENT_KEY_FILE,
      AGENT_NOSTR_CONFIG: env.NOSTR_AGENT_CONFIG }
    delete legacyEnv.NOSTR_AGENT_HOME
    delete legacyEnv.NOSTR_AGENT_KEY_FILE
    delete legacyEnv.NOSTR_AGENT_CONFIG
    const result = spawnSync(path.join(env.NOSTR_AGENT_BIN_DIR, 'agent-nostr'), ['whoami', '--json'], { env: legacyEnv, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).npub, expected)
    const human = spawnSync(path.join(env.NOSTR_AGENT_BIN_DIR, 'agent-nostr'), ['config'], { env: legacyEnv, encoding: 'utf8' })
    assert.match(human.stderr, /agent-nostr is deprecated; use nostr-agent/)
  })

  await t.test('invalid existing key is not replaced during initialization', async () => {
    await fs.writeFile(env.NOSTR_AGENT_KEY_FILE, 'invalid-key', { mode: 0o600 })
    run(path.join(env.NOSTR_AGENT_BIN_DIR, 'nostr-agent'), ['init', '--json'], repo, 1)
    assert.equal(await fs.readFile(env.NOSTR_AGENT_KEY_FILE, 'utf8'), 'invalid-key')
  })
})
