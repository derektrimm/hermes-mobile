// Driving one chat from the phone and another device at once, against a stand-in gateway: turns
// typed on the PC, a re-join while text streams, Stop with messages queued, merged follow-ups, and
// a skill command that resolves after the phone moved to another chat.
import assert from 'node:assert/strict'
import { BASE, chromium, devices } from './env.mjs'

const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'], colorScheme: 'dark' })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))

const calls = []
let pcStored = ''
const overrides = {}
const delays = {}
let socket
let created = 0
let seq = 0
const send = frame => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
const event = (type, payload = {}, sid) => send({ method: 'event', params: { type, session_id: sid, seq: ++seq, payload } })
const lastCall = method => [...calls].reverse().find(c => c.method === method)
const waitFor = async (fn, what) => {
  for (let i = 0; i < 80; i++) {
    if (await fn()) {
      return
    }

    await page.waitForTimeout(100)
  }

  throw new Error(`timed out: ${what}`)
}
const assistantTexts = () => page.locator('.msg.assistant').allInnerTexts()
const userTexts = () => page.locator('.msg.user .bubble').allInnerTexts()

const pcCalls = []

await page.routeWebSocket(/\/api\/ws(\?|$)/, ws => {
  const backend = new URL(ws.url()).searchParams.get('backend') || 'main'

  if (backend !== 'main') {
    // A shared PC window's backend: it has the chat live as runtime p9.
    ws.onMessage(raw => {
      const frame = JSON.parse(raw)

      if (!frame.method) {
        return
      }

      pcCalls.push({ method: frame.method, params: frame.params })
      const results = {
        'session.active_list': { sessions: [{ id: 'p9', session_key: pcStored }] },
        'session.activate': { session_id: 'p9', session_key: pcStored, messages: [], running: false },
        'prompt.submit': { status: 'streaming' },
        'session.events.since': { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'p', open_requests: [] }
      }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: results[frame.method] ?? {} }))
    })
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'p' } } }))

    return
  }

  socket = ws
  ws.onMessage(async raw => {
    const frame = JSON.parse(raw)

    if (!frame.method) {
      return
    }

    calls.push({ method: frame.method, params: frame.params })

    if (delays[frame.method]) {
      await new Promise(r => setTimeout(r, delays[frame.method]))
    }

    if (overrides[frame.method]) {
      const out = overrides[frame.method](frame.params)
      send(out?.error ? { id: frame.id, error: out.error } : { id: frame.id, result: out })

      return
    }

    const results = {
      'client.capabilities': { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true },
      'session.create': () => {
        created += 1

        return { session_id: `c${created}`, stored_session_id: `stored-c${created}`, message_count: 0, messages: [], info: { model: 'claude-opus-5-5' } }
      },
      'session.activate': () => ({ session_id: frame.params.session_id, session_key: `stored-${frame.params.session_id}`, messages: [], running: false }),
      'prompt.submit': { status: 'streaming' },
      'session.interrupt': { status: 'interrupted' },
      'session.events.since': { events: [], latest_seq: seq, truncated: false, count: 0, epoch: 'e', open_requests: [] }
    }
    const result = results[frame.method]
    send({ id: frame.id, result: typeof result === 'function' ? result() : result ?? {} })
  })
  send({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'e' } } })
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.querySelector('.conn-banner'), null, { timeout: 15000 })

// A chat with one finished turn from the phone.
await page.fill('.composer textarea', 'phone question')
await page.click('button[aria-label="Send"]')
await waitFor(() => lastCall('prompt.submit')?.params.text === 'phone question', 'first submit')
const sid = lastCall('prompt.submit').params.session_id
event('message.start', {}, sid)
event('message.delta', { text: 'phone answer' }, sid)
event('message.complete', { text: 'phone answer', status: 'complete' }, sid)
await page.waitForFunction(() => !document.querySelector('.send.stop'))

// HM_ONLY=3 runs only test 3 (after the shared setup), to see one test fail on its own.
const only = n => !process.env.HM_ONLY || process.env.HM_ONLY === String(n)

// 1. A turn typed on the PC: its prompt shows (read from the live session) and its answer, sent only
//    in message.complete (no stream), is shown as its own answer, not dropped next to the old one.
if (only(1)) {
  overrides['session.activate'] = p =>
    p.omit_messages ? { session_id: p.session_id, running: true, inflight: { user: 'typed on the PC', assistant: '' } } : { session_id: p.session_id, messages: [] }
  event('message.start', {}, sid)
  event('message.complete', { text: 'answer to the PC', status: 'complete' }, sid)
  await waitFor(async () => (await userTexts()).includes('typed on the PC'), 'PC prompt shown')
  await waitFor(async () => (await assistantTexts()).some(t => t.includes('answer to the PC')), 'PC answer shown')
  assert.deepEqual(await userTexts(), ['phone question', 'typed on the PC'])
  assert.ok((await assistantTexts()).some(t => t.includes('phone answer')), 'the earlier answer stays')
  delete overrides['session.activate']
  console.log('1 ok: a turn typed on the PC shows its prompt and its own answer')
}

// 2. A re-join while text streams: the snapshot already holds "AB"; the deltas "A" and "B" that
//    arrived during the re-join must not be added again, and "C" after it must be.
// The connection drops; the phone reconnects and re-joins; "A" and "B" stream while that re-join
// is being answered.
if (only(2)) {
  event('message.start', {}, sid)
  await page.waitForSelector('.send.stop')
  delays['session.activate'] = 500
  overrides['session.activate'] = p => ({ session_id: p.session_id, running: true, inflight: { user: 'phone question', assistant: 'AB' }, messages: [] })
  const activations = calls.filter(c => c.method === 'session.activate').length
  await socket.close()
  await waitFor(() => calls.filter(c => c.method === 'session.activate').length > activations, 're-join')
  event('message.delta', { text: 'A' }, sid)
  event('message.delta', { text: 'B' }, sid)
  await page.waitForTimeout(800)
  event('message.delta', { text: 'C' }, sid)
  await waitFor(async () => (await assistantTexts()).some(t => t.includes('ABC')), 'ABC shown')
  assert.ok(!(await assistantTexts()).some(t => t.includes('ABAB')), 'no doubled text')
  delete delays['session.activate']
  delete overrides['session.activate']
  event('message.complete', { text: 'ABC', status: 'complete' }, sid)
  await page.waitForFunction(() => !document.querySelector('.send.stop'))
  console.log('2 ok: re-join while streaming shows ABC, not ABAB')
}

// 3. Two follow-ups queued during a turn are merged by Hermes into one prompt: when that turn
//    starts both leave "Queued" together.
if (only(3)) {
  event('message.start', {}, sid)
  await page.waitForSelector('.send.stop')
  overrides['prompt.submit'] = () => ({ status: 'queued' })
  for (const text of ['first follow-up', 'second follow-up']) {
    await page.fill('.composer textarea', text)
    await page.click('button[aria-label="Send follow-up"]')
    await waitFor(() => lastCall('prompt.submit')?.params.text === text, text)
  }
  assert.equal(await page.locator('.queued-label').count(), 2)
  delete overrides['prompt.submit']
  event('message.complete', { text: 'done', status: 'complete' }, sid)
  event('message.start', {}, sid)
  await waitFor(async () => (await page.locator('.queued-label').count()) === 0, 'both admitted')
  assert.ok((await userTexts()).some(t => t.includes('first follow-up') && t.includes('second follow-up')), 'shown as the one merged prompt')
  event('message.complete', { text: 'merged answer', status: 'complete' }, sid)
  await page.waitForFunction(() => !document.querySelector('.send.stop'))
  console.log('3 ok: merged follow-ups admitted together')
}

// 4. Stop with a follow-up queued: Hermes drops the queue, so the text goes back to the composer.
if (only(4)) {
  event('message.start', {}, sid)
  await page.waitForSelector('.send.stop')
  overrides['prompt.submit'] = () => ({ status: 'queued' })
  await page.fill('.composer textarea', 'never sent')
  await page.click('button[aria-label="Send follow-up"]')
  await page.waitForSelector('.queued-label')
  delete overrides['prompt.submit']
  await page.click('.send.stop')
  await waitFor(() => lastCall('session.interrupt'), 'interrupt')
  event('message.complete', { text: '', status: 'interrupted' }, sid)
  await waitFor(async () => (await page.locator('.composer textarea').inputValue()) === 'never sent', 'text back in the composer')
  assert.equal(await page.locator('.queued-label').count(), 0)
  await page.fill('.composer textarea', '')
  console.log('4 ok: Stop returns the queued message to the composer')
}

// 5. A skill command whose expansion arrives after the phone opened another chat goes to the chat
//    it was typed in.
if (only(5)) {
  overrides['slash.exec'] = () => ({ error: { code: 4018, message: 'use command.dispatch' } })
  delays['command.dispatch'] = 1200
  overrides['command.dispatch'] = () => ({ type: 'skill', message: 'expanded skill prompt' })
  await page.fill('.composer textarea', '/review the diff')
  await page.click('button[aria-label="Send"]')
  await page.waitForTimeout(200)
  await page.click('button[aria-label="New chat"] >> nth=0')
  await waitFor(() => lastCall('prompt.submit')?.params.text === 'expanded skill prompt', 'skill submit')
  assert.equal(lastCall('prompt.submit').params.session_id, sid, 'sent to the chat that ran the command')
  assert.equal(await page.locator('.msg.user').count(), 0, 'the new chat stays empty')
  console.log('5 ok: a late skill expansion lands in its own chat')
}

// 6. A chat with no runtime here (put to sleep) that has meanwhile been opened in a shared PC
//    window: sending joins the window's backend and goes there, never a second copy on the server.
if (only(6)) {
  await page.click('button[aria-label="New chat"] >> nth=0')
  await page.fill('.composer textarea', 'start a chat')
  await page.click('button[aria-label="Send"]')
  await waitFor(() => lastCall('prompt.submit')?.params.text === 'start a chat', 'chat created')
  const live6 = lastCall('prompt.submit').params.session_id
  pcStored = `stored-${live6}`
  event('message.start', {}, live6)
  event('message.complete', { text: 'started', status: 'complete' }, live6)
  await page.waitForFunction(() => !document.querySelector('.send.stop'))
  send({ method: 'event', params: { type: 'session.reclaimed', session_id: '', payload: { session_id: live6, stored_session_id: pcStored, reason: 'idle_timeout' } } })
  await page.waitForSelector('.notice:has-text("put this chat to sleep")')
  await page.route('**/hm/live', route =>
    route.fulfill({
      json: {
        sessions: [{ session_id: pcStored, holder: 'pc-shared', holder_label: 'a Hermes window on your PC', backend: 'pc-9', profile: null }],
        backends: ['main', 'pc-9'],
        phone_chats: []
      }
    })
  )
  const resumes = calls.filter(c => c.method === 'session.resume' || c.method === 'session.activate').length
  await page.fill('.composer textarea', 'typed after the window came back')
  await page.click('button[aria-label="Send"]')
  await waitFor(() => pcCalls.some(c => c.method === 'prompt.submit'), 'submit on the PC backend')
  assert.equal(pcCalls.find(c => c.method === 'prompt.submit').params.session_id, 'p9')
  assert.equal(calls.filter(c => c.method === 'session.resume' || c.method === 'session.activate').length, resumes, 'no second copy on the server')
  assert.ok(!calls.some(c => c.method === 'prompt.submit' && c.params.text === 'typed after the window came back'), 'not sent on the server')
  await page.unroute('**/hm/live')
  console.log('6 ok: a chat re-opened in a shared PC window is joined there, not copied on the server')
}

console.log('errors', JSON.stringify(errors))
assert.deepEqual(errors, [])
await browser.close()
