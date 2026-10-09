// A reconnect in the middle of a turn (phone waking, wifi to cellular) must not lose the rest of it.
// The stand-in gateway holds the reconnect replay (session.events.since) open while the turn keeps
// going: the frames sent during that hold are delivered as "replayed". The phone must still end up
// with the whole answer and a finished turn, not half an answer under a spinner that never stops.
import assert from 'node:assert/strict'
import { BASE, chromium, devices } from './env.mjs'

const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'], colorScheme: 'dark' })
const page = await context.newPage()
// The stand-in's chats are not real: keep them out of the server's list of phone chats.
await page.route('**/hm/phone-chat', route => route.fulfill({ json: { ok: true } }))
const errors = []
page.on('pageerror', e => errors.push(String(e)))

// The backend's view of the one chat.
const turn = { user: '', answer: '', running: false }
let seq = 0
let sockets = 0
let socket
const send = (ws, frame) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
const event = (ws, type, payload = {}) => send(ws, { method: 'event', params: { type, session_id: 'm1', seq: ++seq, payload } })
const snapshot = () => ({
  session_id: 'm1',
  session_key: 'stored-m1',
  info: { model: 'claude-opus-5-5' },
  running: turn.running,
  messages: turn.running ? [] : [{ role: 'user', content: turn.user }, { role: 'assistant', content: turn.answer }],
  message_count: turn.running ? 0 : 2,
  inflight: turn.running ? { user: turn.user, assistant: turn.answer } : null
})

await page.routeWebSocket(/\/api\/ws$/, ws => {
  sockets += 1
  socket = ws
  const reconnect = sockets > 1

  ws.onMessage(async raw => {
    const frame = JSON.parse(raw)

    if (!frame.method) {
      return
    }

    if (frame.method === 'session.events.since' && reconnect) {
      // The turn carries on while the replay answer is on its way.
      setTimeout(() => {
        turn.answer += ' world'
        event(ws, 'message.delta', { text: ' world' })
      }, 100)
      setTimeout(() => {
        turn.running = false
        event(ws, 'message.complete', { text: turn.answer, status: 'complete' })
      }, 200)
      await new Promise(r => setTimeout(r, 600))
      send(ws, { id: frame.id, result: { events: [], latest_seq: 2, truncated: false, count: 0, epoch: 'e', open_requests: [] } })

      return
    }

    const results = {
      'client.capabilities': { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true },
      'session.create': { session_id: 'm1', stored_session_id: 'stored-m1', message_count: 0, messages: [], info: { model: 'claude-opus-5-5' } },
      'session.activate': snapshot,
      'session.resume': snapshot,
      'prompt.submit': () => {
        turn.user = frame.params.text
        turn.running = true
        setTimeout(() => {
          event(ws, 'message.start')
          turn.answer = 'Hello'
          event(ws, 'message.delta', { text: 'Hello' })
        }, 50)

        return { status: 'streaming' }
      },
      'session.events.since': { events: [], latest_seq: seq, truncated: false, count: 0, epoch: 'e', open_requests: [] }
    }
    const result = results[frame.method]
    send(ws, { id: frame.id, result: typeof result === 'function' ? result() : result ?? {} })
  })
  send(ws, { method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'e' } } })
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.querySelector('.conn-banner'), null, { timeout: 15000 })
await page.fill('.composer textarea', 'say hello world')
await page.click('button[aria-label="Send"]')
await page.waitForFunction(() => document.querySelector('.msg.assistant')?.textContent?.includes('Hello'), null, { timeout: 10000 })

// The connection drops mid-answer; the phone reconnects on its own.
await socket.close()
await page.waitForFunction(() => document.querySelector('.msg.assistant')?.textContent?.includes('Hello world'), null, { timeout: 20000 }).catch(() => {})
await page.waitForTimeout(1500)

const answer = await page.locator('.msg.assistant').last().innerText()
const spinning = await page.locator('.send.stop').count()
console.log('sockets:', sockets, 'answer:', JSON.stringify(answer), 'still running:', spinning > 0)
assert.ok(sockets >= 2, 'the phone reconnected')
assert.match(answer, /Hello world/, 'the part of the answer sent during the reconnect is shown')
assert.equal(spinning, 0, 'the finished turn is shown finished')
assert.deepEqual(errors, [])
console.log('reconnect ok: nothing lost, turn finished')
await browser.close()
