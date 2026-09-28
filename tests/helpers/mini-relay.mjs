// Minimal in-memory NIP-01 relay for tests: EVENT with signature check,
// REQ answered from storage followed by EOSE, and CLOSE. No live
// subscriptions, NIP-42 or replaceable-event pruning.
export async function startRelay({ WebSocketServer, verifyEvent, maxLimit = 500 }) {
  const events = new Map()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))

  function matches(filter, event) {
    if (filter.ids && !filter.ids.includes(event.id)) return false
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false
    if (filter.since !== undefined && event.created_at < filter.since) return false
    if (filter.until !== undefined && event.created_at > filter.until) return false
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue
      if (!event.tags.some(t => t[0] === key.slice(1) && values.includes(t[1]))) return false
    }
    return true
  }

  function query(filters) {
    const result = new Map()
    for (const filter of filters) {
      const limit = Math.min(filter.limit ?? maxLimit, maxLimit)
      const found = [...events.values()]
        .filter(event => matches(filter, event))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, limit)
      for (const event of found) result.set(event.id, event)
    }
    return [...result.values()]
  }

  server.on('connection', socket => {
    socket.on('message', raw => {
      let message
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!Array.isArray(message)) return
      const [type, ...rest] = message
      if (type === 'EVENT') {
        const event = rest[0]
        const valid = Boolean(event) && verifyEvent(event)
        if (valid) events.set(event.id, event)
        socket.send(JSON.stringify(['OK', event?.id ?? '', valid, valid ? '' : 'invalid: bad signature']))
      } else if (type === 'REQ') {
        const [subscription, ...filters] = rest
        for (const event of query(filters)) socket.send(JSON.stringify(['EVENT', subscription, event]))
        socket.send(JSON.stringify(['EOSE', subscription]))
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    events,
    // Stores an event directly, as if another client had published it.
    inject(event) {
      events.set(event.id, event)
    },
    close() {
      for (const client of server.clients) client.terminate()
      return new Promise(resolve => server.close(resolve))
    },
  }
}
