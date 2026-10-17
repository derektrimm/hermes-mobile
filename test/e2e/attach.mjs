// Files both ways and steering, end to end against a stand-in gateway: a document attached from the
// phone is staged with file.attach and named in the prompt; a reply's MEDIA: picture shows inline
// (read through /hm/file, stubbed here with a real PNG) and opens full screen; "Steer now" sends
// session.steer to the running turn, and a steer Hermes refuses runs after the turn instead.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BASE, chromium, devices } from './env.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.env.HM_SHOTS || `${process.env.TMPDIR || '/tmp'}/`
const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'], colorScheme: 'dark' })
const page = await context.newPage()
await page.route('**/hm/phone-chat', route => route.fulfill({ json: { ok: true } }))
const fileRequests = []
const png = await readFile(path.join(here, 'blue.png'))
await page.route('**/hm/file?**', route => {
  fileRequests.push(new URL(route.request().url()).searchParams)
  route.fulfill({ status: 200, contentType: 'image/png', body: png })
})
const errors = []
page.on('pageerror', e => errors.push(String(e)))

const calls = []
let socket
let steerStatus = 'queued'
const send = frame => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
const event = (type, payload = {}) => send({ method: 'event', params: { type, session_id: 'm1', payload } })

await page.routeWebSocket(/\/api\/ws$/, ws => {
  socket = ws
  ws.onMessage(raw => {
    const frame = JSON.parse(raw)

    if (!frame.method) {
      return
    }

    calls.push(frame)
    const results = {
      'client.capabilities': { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true },
      'session.create': { session_id: 'm1', stored_session_id: 'mock-attach', message_count: 0, messages: [], info: { model: 'claude-opus-5-5' } },
      'file.attach': { attached: true, name: 'notes.txt', path: '/w/attachments/notes.txt', ref_path: 'attachments/notes.txt', ref_text: '@file:attachments/notes.txt', uploaded: true },
      'prompt.submit': { status: 'streaming' },
      'session.steer': { status: steerStatus, text: frame.params?.text ?? '' }
    }
    send({ id: frame.id, result: results[frame.method] ?? {} })
  })
  send({ method: 'event', params: { type: 'gateway.ready', payload: {} } })
})

const called = method => calls.filter(c => c.method === method)

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.querySelector('.conn-banner'), null, { timeout: 15000 })

// 1. A document from the phone: shown as a chip, staged with file.attach, named in the prompt.
await page.setInputFiles('.composer input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('buy milk\n') })
await page.waitForSelector('.attachment.file')
assert.equal(await page.locator('.attachment-file').innerText(), 'notes.txt')
await page.fill('.composer textarea', 'What is on this list?')
await page.screenshot({ path: `${OUT}attach-1-file.png` })
await page.click('button[aria-label="Send"]')
await page.waitForSelector('.send.stop')
const [attach] = called('file.attach')
assert.equal(attach.params.name, 'notes.txt')
assert.equal(attach.params.data_url, `data:text/plain;base64,${Buffer.from('buy milk\n').toString('base64')}`)
const [submit] = called('prompt.submit')
assert.equal(submit.params.text, '@file:attachments/notes.txt\n\nWhat is on this list?')
assert.equal(await page.locator('.msg.user .msg-files').innerText(), 'notes.txt')
console.log('1 ok: a document is staged with file.attach and named in the prompt')

// 2. Steer now: the running turn gets session.steer, and the chat says so.
event('message.start')
event('message.delta', { text: 'Reading the list' })
await page.fill('.composer textarea', 'Also check the eggs')
await page.waitForSelector('.followup-mode')
await page.click('.followup-mode >> text=Steer now')
await page.waitForTimeout(300) // let the switch finish its transition before the picture
await page.screenshot({ path: `${OUT}attach-2-steer.png` })
await page.click('button[aria-label="Steer"]')
await page.waitForFunction(() => [...document.querySelectorAll('.notice')].some(n => n.textContent.includes('Steered: Also check the eggs')))
const [steer] = called('session.steer')
assert.deepEqual([steer.params.session_id, steer.params.text], ['m1', 'Also check the eggs'])
assert.equal(called('prompt.submit').length, 1, 'a steer is not a new prompt')
console.log('2 ok: Steer now sends session.steer to the running turn')

// 3. A steer Hermes refuses runs after the turn instead (queued, never an interrupt).
steerStatus = 'rejected'
await page.fill('.composer textarea', 'And the bread')
await page.click('button[aria-label="Steer"]')
await page.waitForFunction(() => document.body.textContent.includes('runs after this turn'))
await page.waitForFunction(() => document.querySelectorAll('.queued-label').length > 0 || document.body.textContent.includes('And the bread'))
const queued = called('prompt.submit').at(-1)
assert.deepEqual([queued.params.text, queued.params.queued], ['And the bread', true])
console.log('3 ok: a refused steer is sent to run after the turn')

// 4. The reply delivers a picture: it leaves the text, shows inline, and opens full screen.
event('message.complete', { text: 'Here is your chart:\n\nMEDIA:/tmp/chart.png\n\nAll set.', status: 'complete' })
await page.waitForSelector('.media-picture.ready img', { timeout: 15000 })
const reply = page.locator('.msg.assistant').last()
assert.ok(!(await reply.innerText()).includes('MEDIA:'))
// The picture sits where the reply put it: between its two sentences.
assert.deepEqual(
  await reply.evaluate(el => [...el.children].filter(c => !c.classList.contains('msg-actions')).map(c => (c.classList.contains('media') ? 'media' : c.textContent.trim()))),
  ['Here is your chart:', 'media', 'All set.']
)
const asked = fileRequests[0]
assert.deepEqual([asked.get('path'), asked.get('backend'), asked.get('profile')], ['/tmp/chart.png', 'main', 'default'])
await page.screenshot({ path: `${OUT}attach-4-media.png` })
await page.click('.media-picture')
await page.waitForSelector('.viewer img')
await page.waitForTimeout(300)
assert.equal(await page.locator('.viewer-name').innerText(), 'chart.png')
await page.screenshot({ path: `${OUT}attach-5-viewer.png` })
await page.click('.viewer button[aria-label="Close"]')
await page.waitForSelector('.viewer', { state: 'detached' })
console.log('4 ok: a MEDIA picture shows inline and opens full screen')

// 5. A file the phone may not open shows by name only, and is never requested.
event('message.start')
event('message.complete', { text: 'Key is at MEDIA:/home/derek/.ssh/id_ed25519.png', status: 'complete' })
await page.waitForSelector('.media-file.off')
assert.equal(fileRequests.filter(q => q.get('path').includes('.ssh')).length, 0)
console.log('5 ok: a file from a hidden folder shows by name and is not fetched')

assert.deepEqual(errors, [])
await browser.close()
