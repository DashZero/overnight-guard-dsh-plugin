import { createServer } from 'node:http'

const port = process.argv[2] || 9999
const mode = process.argv[3] || 'normal'

const server = createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`)

  if (mode === 'hang') {
    // Never respond — simulates a hanging stream
    console.log('  -> hanging (no response)')
    return
  }

  if (mode === '503') {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Service Unavailable', code: 'service_unavailable' } }))
    return
  }

  if (mode === 'empty') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'mock-1',
      object: 'chat.completion',
      created: Date.now(),
      model: 'mock',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop'
      }]
    }))
    return
  }

  if (mode === 'tool-as-text') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'mock-1',
      object: 'chat.completion',
      created: Date.now(),
      model: 'mock',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'bash -c "ls -la"' },
        finish_reason: 'stop'
      }]
    }))
    return
  }

  // Normal response
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'mock-1',
    object: 'chat.completion',
    created: Date.now(),
    model: 'mock',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'OK, I will continue with the task.' },
      finish_reason: 'stop'
    }]
  }))
})

server.listen(port, () => {
  console.log(`Mock provider listening on http://127.0.0.1:${port} in mode: ${mode}`)
})
