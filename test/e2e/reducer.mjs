// The chat reducer and actions against a stand-in gateway: the test plays the Hermes backend on the
// app's own WebSocket and checks what the app puts on the wire and on screen.
import assert from 'node:assert/strict'
import { BASE, chromium, devices } from './env.mjs'

const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'], colorScheme: 'dark' })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))

const calls = []
const answers = new Map()
const delays = {}
const overrides = {}
let socket
let createCount = 0
const send = frame => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
const event = (type, payload = {}, sid = 'm1') => send({ method: 'event', params: { type, session_id: sid, payload } })
const snapshot = sid => ({ session_id: sid, session_key: `stored-${sid}`, message_count: 0, messages: [], info: { model: 'claude-opus-5-5' }, running: false })

await page.routeWebSocket(/\/api\/ws$/, ws => {
  socket = ws
  ws.onMessage(async raw => {
    const frame = JSON.parse(raw)

    if (!frame.method) {
      if (typeof frame.id === 'string' && frame.id.startsWith('srq-')) {
        answers.set(frame.id, frame.result ?? frame.error)
      }

      return
    }

    calls.push({ method: frame.method, params: frame.params })

    if (delays[frame.method]) {
      await new Promise(r => setTimeout(r, delays[frame.method]))
    }

    if (overrides[frame.method]) {
      const out = overrides[frame.method](frame.params)

      if (out?.error) {
        send({ id: frame.id, error: out.error })

        return
      }

      send({ id: frame.id, result: out })

      return
    }

    const results = {
      'client.capabilities': { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true },
      'session.create': () => {
        createCount += 1
        const sid = `m${createCount}`

        return { session_id: sid, stored_session_id: `stored-${sid}`, message_count: 0, messages: [], info: { model: frame.params.model || 'claude-opus-5-5' } }
      },
      'session.activate': () => snapshot(frame.params.session_id),
      'session.resume': () => snapshot('m1'),
      'prompt.submit': { status: 'streaming' },
      'model.options': { providers: [{ slug: 'anthropic', name: 'Anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], authenticated: true, is_current: true }], model: 'claude-opus-5-5', provider: 'anthropic' },
      'session.events.since': { events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'e', open_requests: [] }
    }
    const result = results[frame.method]
    send({ id: frame.id, result: typeof result === 'function' ? result() : result ?? {} })
  })
  send({ method: 'event', params: { type: 'gateway.ready', payload: {} } })
})

const lastCall = method => [...calls].reverse().find(c => c.method === method)
const waitFor = async (fn, what) => {
  for (let i = 0; i < 60; i++) {
    if (await fn()) {
      return
    }

    await page.waitForTimeout(100)
  }

  throw new Error(`timed out: ${what}`)
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.querySelector('.conn-banner'), null, { timeout: 15000 })

// 1. A model picked before the first message is created with the chat.
await page.click('.title-btn')
await page.waitForTimeout(400)
await page.click('.sheet.open .setting:has-text("Model")')
await page.waitForSelector('.sheet.open .models')
await page.click('.sheet.open .models .setting:has-text("Sonnet 5.5")')
await page.waitForTimeout(400)
await page.click('.title-btn')
await page.waitForTimeout(400)
await page.click('.sheet.open .setting:has-text("Effort")')
await page.click('.sheet.open .setting:has(.setting-main > span:first-child:text-is("Max"))')
await page.waitForTimeout(400)
await page.fill('.composer textarea', 'first question')
await page.click('button[aria-label="Send"]')
await waitFor(() => lastCall('prompt.submit'), 'first submit')
assert.equal(lastCall('session.create').params.model, 'claude-sonnet-5-5')
assert.equal(lastCall('session.create').params.provider, 'anthropic')
assert.equal(lastCall('session.create').params.reasoning_effort, 'max')
assert.ok(!calls.some(c => c.method === 'config.set'), 'no separate switch that could fail after the send')
console.log('1 ok: model and effort chosen before the first message ride on session.create')

// 2. Interim text, a tool, then a final answer that was never streamed, and reasoning
//    reported before any answer exists.
event('message.start')
event('message.interim', { text: 'I will check.', already_streamed: false })
event('tool.start', { tool_id: 't1', name: 'terminal', context: 'uptime' })
event('tool.complete', { tool_id: 't1', name: 'terminal', result: { output: 'up 3 days', exit_code: 0 } })
event('reasoning.available', { text: 'The uptime answers it.' })
event('message.complete', { text: 'The final answer is 42.', status: 'complete' })
await page.waitForFunction(() => !document.querySelector('.send.stop'))
// The create-time effort is stored with the chat once its first turn has run.
await waitFor(() => calls.some(c => c.method === 'config.set' && c.params.key === 'reasoning' && c.params.value === 'max'), 'effort stored after the first turn')
const texts = await page.locator('.msg.assistant').allInnerTexts()
assert.ok(texts.some(t => t.includes('I will check.')), 'interim shown')
assert.ok(texts.some(t => t.includes('The final answer is 42.')), 'final answer shown')
console.log('2 ok: interim and final answer both shown; reasoning kept:', await page.locator('.work').count() > 0)

// 3. A follow-up queued mid-turn waits outside the transcript, the answer stays one piece, and the
//    follow-up joins the transcript when its turn starts.
event('message.start')
event('message.delta', { text: 'Working on part one' })
overrides['prompt.submit'] = () => ({ status: 'queued' })
await page.fill('.composer textarea', 'also do part two')
await page.click('button[aria-label="Send follow-up"]')
await page.waitForSelector('.queued-label')
event('message.delta', { text: ' and still going.' })
await page.waitForTimeout(200)
const lastAnswer = await page.locator('.msg.assistant').last().innerText()
assert.ok(lastAnswer.includes('Working on part one and still going.'), `answer in one piece: ${lastAnswer}`)
event('message.complete', { text: 'Working on part one and still going.', status: 'complete' })
event('message.start')
await page.waitForFunction(() => !document.querySelector('.queued-label'))
const userTexts = await page.locator('.msg.user .bubble').allInnerTexts()
assert.equal(userTexts[userTexts.length - 1], 'also do part two')
event('message.complete', { text: 'Part two done.', status: 'complete' })
delete overrides['prompt.submit']
console.log('3 ok: queued follow-up kept aside, answer unbroken, admitted when its turn started')

// 4. A stale question: answered elsewhere, the backend no longer lists it.
send({ id: 'srq-9', method: 'approval', params: { session_id: 'm1', request_id: 'q9', command: 'ls', choices: ['once', 'deny'] } })
await page.waitForSelector('.ask')
event('tool.start', { tool_id: 't9', name: 'terminal', context: 'ls' })
await page.waitForSelector('.ask', { state: 'detached', timeout: 5000 })
console.log('4 ok: a question answered elsewhere leaves the phone')

// 5. approval.cancelled arrives as a broadcast (no envelope session) naming approval-queue ids.
send({ id: 'srq-10', method: 'approval', params: { session_id: 'm1', request_id: 'q10', command: 'ls', choices: ['once', 'deny'] } })
await page.waitForSelector('.ask')
send({ method: 'event', params: { type: 'approval.cancelled', session_id: '', payload: { session_id: 'm1', stored_session_id: 'stored-m1', reason: 'interrupt', cancelled_count: 1, request_ids: ['q10'] } } })
await page.waitForSelector('.ask', { state: 'detached', timeout: 5000 })
console.log('5 ok: broadcast approval.cancelled removes the card')

// 6. session.reclaimed arrives as a broadcast; the next send re-joins.
send({ method: 'event', params: { type: 'session.reclaimed', session_id: '', payload: { session_id: 'm1', stored_session_id: 'stored-m1', reason: 'idle_timeout' } } })
await page.waitForSelector('.notice:has-text("put this chat to sleep")')
const before = calls.length
await page.fill('.composer textarea', 'are you there')
await page.click('button[aria-label="Send"]')
await waitFor(() => calls.slice(before).some(c => c.method === 'prompt.submit'), 'resend')
const rejoin = calls.slice(before).find(c => c.method === 'session.resume' || c.method === 'session.activate')
assert.ok(rejoin, 'rejoined before sending')
event('message.complete', { text: 'yes', status: 'complete' })
console.log('6 ok: reclaimed runtime dropped and re-joined on the next send via', rejoin.method)

// 7. Skill commands fall back to command.dispatch.
overrides['slash.exec'] = () => ({ error: { code: 4018, message: 'skill command: use command.dispatch for /deploy' } })
overrides['command.dispatch'] = () => ({ type: 'send', message: 'Run the deploy skill for staging' })
const beforeSkill = calls.length
await page.fill('.composer textarea', '/deploy staging')
await page.click('button[aria-label="Send"]')
await waitFor(() => calls.slice(beforeSkill).some(c => c.method === 'prompt.submit'), 'skill submit')
const dispatch = calls.slice(beforeSkill).find(c => c.method === 'command.dispatch')
assert.deepEqual([dispatch.params.name, dispatch.params.arg], ['deploy', 'staging'])
assert.equal(lastCall('prompt.submit').params.text, 'Run the deploy skill for staging')
event('message.complete', { text: 'ok', status: 'complete' })
console.log('7 ok: skill command dispatched and its prompt sent')

// 8. A photo upload that fails half way takes back the photo already staged.
let attachCount = 0
overrides['image.attach_bytes'] = () => (++attachCount === 1 ? { attached: true, path: '/tmp/a.jpg' } : { error: { code: 5000, message: 'disk full' } })
await page.setInputFiles('.composer input[type=file]', [new URL('blue.png', import.meta.url).pathname, new URL('blue.png', import.meta.url).pathname])
await page.waitForSelector('.attachment img')
await page.fill('.composer textarea', 'two photos')
await page.click('button[aria-label="Send"]')
await waitFor(() => calls.some(c => c.method === 'image.detach'), 'detach')
assert.equal(lastCall('image.detach').params.path, '/tmp/a.jpg')
assert.equal(await page.locator('.attachment img').count(), 2, 'photos back in the composer')
console.log('8 ok: staged photo detached after a failed upload; composer restored')
delete overrides['image.attach_bytes']
await page.locator('.attachment button').first().click()
await page.locator('.attachment button').first().click()
await page.fill('.composer textarea', '')

// 9. A send whose chat is still being created lands in that chat, not in the chat opened meanwhile.
await page.click('button[aria-label="New chat"] >> nth=0')
delays['session.create'] = 1500
await page.fill('.composer textarea', 'instructions for chat A')
await page.click('button[aria-label="Send"]')
await page.waitForTimeout(150)
await page.click('button[aria-label="New chat"] >> nth=0')
await waitFor(() => lastCall('prompt.submit')?.params.text === 'instructions for chat A', 'late submit')
const created = calls.filter(c => c.method === 'session.create').length
assert.equal(lastCall('prompt.submit').params.session_id, `m${created}`)
assert.equal(await page.locator('.msg.user').count(), 0, 'the newly opened chat stays empty')
delete delays['session.create']
console.log('9 ok: delayed send went to its own chat; the new chat stayed empty')

// 10. A message sent while the phone believes the chat is idle always goes as "run after": if the
//     PC started a turn a moment earlier, Hermes queues it instead of interrupting that turn, and
//     the phone shows it waiting.
await page.fill('.composer textarea', 'first in chat B')
await page.click('button[aria-label="Send"]')
await waitFor(() => lastCall('prompt.submit')?.params.text === 'first in chat B', 'chat B first submit')
assert.equal(lastCall('prompt.submit').params.queued, true)
const chatB = lastCall('prompt.submit').params.session_id
event('message.start', {}, chatB)
event('message.complete', { text: 'B answered.', status: 'complete' }, chatB)
await page.waitForFunction(() => !document.querySelector('.send.stop'))
overrides['prompt.submit'] = () => ({ status: 'queued' })
await page.fill('.composer textarea', 'sent as the PC started a turn')
await page.click('button[aria-label="Send"]')
await waitFor(() => lastCall('prompt.submit')?.params.text === 'sent as the PC started a turn', 'racing submit')
assert.equal(lastCall('prompt.submit').params.queued, true, 'never an unmarked send that could interrupt')
await page.waitForSelector('.queued-label')
assert.equal(await page.locator('.msg.user:not(.pending)', { hasText: 'sent as the PC started a turn' }).count(), 0, 'not painted as a turn of its own')
delete overrides['prompt.submit']
// The PC's turn runs and ends; then Hermes starts the queued message as the next turn.
event('message.start', {}, chatB)
event('message.complete', { text: 'PC turn done.', status: 'complete' }, chatB)
await page.waitForTimeout(300)
assert.equal(await page.locator('.queued-label').count(), 1, 'still waiting while the PC turn runs')
event('message.start', {}, chatB)
await page.waitForFunction(() => !document.querySelector('.queued-label'))
event('message.complete', { text: 'Done.', status: 'complete' }, chatB)
console.log('10 ok: a send racing a PC turn is queued behind it, never interrupts it')

console.log('errors', JSON.stringify(errors))
assert.deepEqual(errors, [])
await browser.close()
