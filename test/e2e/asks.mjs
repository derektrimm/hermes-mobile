// The agent's questions, end to end against a stand-in gateway: the test plays the backend on the
// app's own WebSocket, sends approval, clarify and sudo requests exactly as tui_gateway frames them,
// and checks the answers the app puts on the wire.
import assert from 'node:assert/strict'
import { BASE, chromium, devices } from './env.mjs'

const OUT = process.env.HM_SHOTS || `${process.env.TMPDIR || '/tmp'}/`
const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'], colorScheme: 'dark' })
const page = await context.newPage()
// The stand-in's chats are not real: keep them out of the server's list of phone chats.
await page.route('**/hm/phone-chat', route => route.fulfill({ json: { ok: true } }))
const errors = []
page.on('pageerror', e => errors.push(String(e)))

const answers = new Map()
let socket
const send = frame => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
const event = (type, payload = {}) => send({ method: 'event', params: { type, session_id: 'm1', payload } })

await page.routeWebSocket(/\/api\/ws$/, ws => {
  socket = ws
  ws.onMessage(raw => {
    const frame = JSON.parse(raw)

    if (frame.method) {
      const results = {
        'client.capabilities': { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true },
        'session.create': { session_id: 'm1', stored_session_id: 'mock-session', message_count: 0, messages: [], info: { model: 'claude-opus-5-5' } },
        'prompt.submit': { status: 'streaming' }
      }
      send({ id: frame.id, result: results[frame.method] ?? {} })
    } else if (typeof frame.id === 'string' && frame.id.startsWith('srq-')) {
      answers.set(frame.id, frame.result ?? frame.error)
    }
  })
  send({ method: 'event', params: { type: 'gateway.ready', payload: {} } })
})

const answered = id => page.waitForFunction(() => true).then(async () => {
  for (let i = 0; i < 50 && !answers.has(id); i++) await page.waitForTimeout(100)
  return answers.get(id)
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.querySelector('.conn-banner'), null, { timeout: 15000 })
await page.fill('.composer textarea', 'clean up the build folder')
await page.click('button[aria-label="Send"]')
await page.waitForSelector('.send.stop')
event('message.start')

// 1. Approval: the card shows the command, and Deny answers {choice: "deny"}.
send({
  id: 'srq-1',
  method: 'approval',
  params: { session_id: 'm1', request_id: 'r1', command: 'rm -rf ./build', description: 'Delete the build folder', choices: ['once', 'session', 'always', 'deny'], allow_session: true, allow_permanent: true }
})
await page.waitForSelector('.ask .ask-command')
assert.equal(await page.locator('.ask .ask-command').innerText(), 'rm -rf ./build')
assert.equal(await page.locator('.ask .btn').count(), 4)
await page.screenshot({ path: `${OUT}ask-1-approval.png` })
await page.click('.ask .btn.danger')
assert.deepEqual(await answered('srq-1'), { choice: 'deny' })
await page.waitForSelector('.ask', { state: 'detached' })
console.log('approval: card shown, Deny answered', JSON.stringify(answers.get('srq-1')))

// 2. Clarify: a choice plus typed text for a second question.
send({
  id: 'srq-2',
  method: 'clarify',
  params: {
    session_id: 'm1',
    questions: [
      { qid: 'q1', question: 'Which build folder?', choices: ['web', 'server'] },
      { qid: 'q2', question: 'Keep the cache?' }
    ]
  }
})
await page.waitForSelector('.ask .chip')
await page.screenshot({ path: `${OUT}ask-2-clarify.png` })
await page.click('.ask .chip >> text=server')
await page.locator('.ask .field').nth(1).fill('yes, keep it')
await page.click('.ask .btn.primary')
assert.deepEqual(await answered('srq-2'), { answers: { q1: 'server', q2: 'yes, keep it' } })
console.log('clarify: answered', JSON.stringify(answers.get('srq-2')))

// 2b. Multi-select answers go as a JSON list, as the desktop app sends them; one answer is enough.
send({
  id: 'srq-2b',
  method: 'clarify',
  params: {
    session_id: 'm1',
    questions: [
      { qid: 'q1', question: 'Which checks?', choices: ['lint', 'unit', 'e2e'], multi_select: true },
      { qid: 'q2', question: 'Anything else?' }
    ]
  }
})
await page.waitForSelector('.ask .chip')
await page.click('.ask .chip >> text=lint')
await page.click('.ask .chip >> text=e2e')
await page.click('.ask .btn.primary')
assert.deepEqual(await answered('srq-2b'), { answers: { q1: '["lint","e2e"]', q2: null } })
console.log('clarify multi-select: answered', JSON.stringify(answers.get('srq-2b')))

// 2c. Skip answers with nothing at all, which Hermes records as cancelled.
send({ id: 'srq-2c', method: 'clarify', params: { session_id: 'm1', questions: [{ qid: 'q1', question: 'Proceed?' }] } })
await page.waitForSelector('.ask .btn.ghost')
await page.click('.ask .btn.ghost')
assert.deepEqual(await answered('srq-2c'), {})
console.log('clarify skip: answered', JSON.stringify(answers.get('srq-2c')))

// 3. Sudo: masked input, Submit answers {value}.
send({ id: 'srq-3', method: 'sudo', params: { session_id: 'm1', command: 'pacman -Syu' } })
await page.waitForSelector('.ask input[type=password]')
await page.fill('.ask input[type=password]', 'hunter2')
await page.screenshot({ path: `${OUT}ask-3-sudo.png` })
await page.click('.ask .btn.primary')
assert.deepEqual(await answered('srq-3'), { value: 'hunter2' })
console.log('sudo: answered')

// 4. A request the phone cannot show is declined, not silently held.
send({ id: 'srq-4', method: 'preview.read', params: { session_id: 'm1' } })
const declined = await answered('srq-4')
assert.ok(declined && declined.code, 'unsupported request answered with an error')
console.log('preview.read: declined with code', declined.code)

// 5. The turn finishes; the answer renders as markdown.
event('message.delta', { text: 'Cleaned **web/build**.' })
event('message.complete', { text: 'Cleaned **web/build**.', status: 'complete' })
await page.waitForFunction(() => !document.querySelector('.send.stop'))
assert.equal(await page.locator('.msg.assistant strong').innerText(), 'web/build')
console.log('turn complete; errors', JSON.stringify(errors))
await browser.close()
