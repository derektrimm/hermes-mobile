// Notifications end to end with a real push service: Firefox subscribes through the app's own sheet
// (Mozilla's push service checks the server's signature and message encryption as strictly as
// Apple's does), then the server sends a test, a reply reported the way the Hermes plugin reports
// one, and the same reply while the chat is on screen, which must stay quiet. The subscription is
// removed at the end. Events are posted to the server's socket over ssh (HM_DEPLOY_HOST).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { BASE } from './env.mjs'

const { firefox } = createRequire(process.env.HM_PLAYWRIGHT_FROM)('playwright')
const HOST = process.env.HM_DEPLOY_HOST
const OUT = process.env.HM_SHOTS || `${process.env.TMPDIR || '/tmp'}/`
assert.ok(HOST, 'set HM_DEPLOY_HOST')

const browser = await firefox.launch({
  firefoxUserPrefs: {
    'dom.push.enabled': true,
    'dom.push.connection.enabled': true,
    'dom.push.serverURL': 'wss://push.services.mozilla.com/',
    'dom.webnotifications.enabled': true,
    'permissions.default.desktop-notification': 1
  }
})
const context = await browser.newContext({ viewport: { width: 430, height: 932 }, colorScheme: 'dark', hasTouch: true })
const page = await context.newPage()
// The throwaway chat is not a real phone chat: keep it out of the server's list.
await page.route('**/hm/phone-chat', route => route.fulfill({ json: { ok: true } }))
const errors = []
page.on('pageerror', e => errors.push(String(e)))

/** Post one event to the server's events socket, as plugin/hermes_mobile_push does. */
function hermesEvent(event) {
  const body = JSON.stringify({ v: 1, home: '', profile: 'default', pid: 1, platform: 'tui', ...event })
  const post = 'curl -fsS --unix-socket /run/user/$(id -u)/hermes-mobile/events.sock -H content-type:application/json --data-binary @- http://local/event'
  execFileSync('ssh', [HOST, `bash -c '${post}'`], { input: body })
}

const shown = () =>
  page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })))

async function waitForNotification(match, ms = 30_000) {
  const until = Date.now() + ms

  while (Date.now() < until) {
    const found = (await shown()).find(match)

    if (found) {
      return found
    }

    await page.waitForTimeout(250)
  }

  return null
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.evaluate(() => navigator.serviceWorker.ready)
await page.click('button[aria-label="Chats"]')
await page.click('button[aria-label="Notifications"]')
await page.waitForSelector('.sheet.open .switch')
await page.screenshot({ path: `${OUT}push-sheet-off.png` })

let failure = null

try {
  // 1. On: the browser subscribes and the server keeps it.
  await page.click('.sheet.open .switch[aria-label="Notifications"]')
  await page.waitForSelector('.sheet.open .switch[aria-label="A reply is ready"]', { timeout: 20_000 })
  assert.equal(await page.locator('.sheet.open .switch').count(), 5)
  await page.screenshot({ path: `${OUT}push-sheet-on.png` })

  // 2. The test notification arrives through Mozilla's push service.
  await page.click('text=Send a test notification')
  const test = await waitForNotification(n => n.tag === 'hermes:test')
  assert.ok(test, 'test notification arrived')
  assert.equal(test.title, 'Hermes')

  // 3. A turn the plugin reports: the reply arrives as words, tagged for its chat.
  const session = `hm-e2e-${Date.now()}`
  hermesEvent({ event: 'turn_start', session_id: session, turn_id: 't1' })
  hermesEvent({ event: 'reply', session_id: session, turn_id: 't1', text: '## Done\n\nThe **build** passes.' })
  hermesEvent({ event: 'turn_end', session_id: session, turn_id: 't1', completed: true, failed: false, interrupted: false })
  const reply = await waitForNotification(n => n.data?.chat?.id === session)
  assert.ok(reply, 'reply notification arrived')
  assert.equal(reply.body, 'Done\n\nThe build passes.')
  assert.equal(reply.tag, `chat:default:${session}`)
  assert.deepEqual(reply.data, { chat: { id: session, profile: 'default' }, kind: 'replies' })

  // 4. The same chat on screen here: its next reply stays quiet.
  await page.evaluate(id => fetch('/hm/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: id, visible: true }) }), `${session}-b`)
  hermesEvent({ event: 'turn_start', session_id: `${session}-b`, turn_id: 't1' })
  hermesEvent({ event: 'reply', session_id: `${session}-b`, turn_id: 't1', text: 'watched' })
  hermesEvent({ event: 'turn_end', session_id: `${session}-b`, turn_id: 't1', completed: true })
  assert.equal(await waitForNotification(n => n.data?.chat?.id === `${session}-b`, 6000), null, 'a chat on screen does not notify')

  // 5. A question waiting on you is urgent and says what it asks.
  hermesEvent({ event: 'input', session_id: session, kind: 'clarify', request_id: `${session}-q`, prompt: 'Ship it to production?' })
  const ask = await waitForNotification(n => n.data?.kind === 'needs')
  assert.ok(ask, 'question notification arrived')
  assert.equal(ask.body, 'Asks: Ship it to production?')

  // 6. With HM_LIVE_TURN=1, a real turn: a throwaway chat started here, left for a new chat at once,
  // notifies when Hermes answers (the plugin in the running backend, end to end). Then deleted.
  if (process.env.HM_LIVE_TURN === '1') {
    await page.keyboard.press('Escape')
    await page.waitForSelector('.sheet.open', { state: 'detached' }).catch(() => undefined)
    await page.mouse.click(415, 450) // the scrim beside the drawer closes it
    await page.waitForSelector('.drawer.open', { state: 'detached' })
    await page.fill('.composer textarea', 'Reply with only the word: pong')
    await page.click('button[aria-label="Send"]')
    await page.waitForFunction(() => document.querySelector('.send.stop'), null, { timeout: 30_000 })
    await page.click('.header button[aria-label="New chat"]')
    const pong = await waitForNotification(n => n.data?.kind === 'replies' && /pong/i.test(n.body), 120_000)
    assert.ok(pong, 'a real reply notified')
    const status = await page.evaluate(
      ({ id, profile }) => fetch(`/api/sessions/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: 'DELETE' }).then(r => r.status),
      pong.data.chat
    )
    assert.ok(status < 300, `throwaway chat deleted (HTTP ${status})`)
    await page.click('button[aria-label="Chats"]')
    await page.click('button[aria-label="Notifications"]')
    await page.waitForSelector('.sheet.open .switch[aria-label="Notifications"]')
  }

  // 7. Off: the browser drops its subscription and so does the server.
  const endpoint = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint)
  await page.click('.sheet.open .switch[aria-label="Notifications"]')
  await page.waitForSelector('.sheet.open .switch[aria-label="A reply is ready"]', { state: 'detached', timeout: 10_000 })
  const server = await page.evaluate(
    e => fetch('/hm/push/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: e }) }).then(r => r.json()),
    endpoint
  )
  assert.equal(server.subscribed, false, 'the server forgot the subscription')
} catch (error) {
  failure = error
  await page.screenshot({ path: `${OUT}push-failure.png` }).catch(() => undefined)
} finally {
  // Whatever happened, no test subscription stays behind, here or on the server.
  const left = await page
    .evaluate(async () => {
      const registration = await navigator.serviceWorker.ready
      const sub = await registration.pushManager.getSubscription()

      if (sub) {
        await fetch('/hm/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) })
        await sub.unsubscribe()
      }

      return Boolean(await registration.pushManager.getSubscription())
    })
    .catch(() => true)
  await browser.close()

  if (failure) {
    throw failure
  }

  assert.equal(left, false, 'unsubscribed at the end')
}

assert.deepEqual(errors, [])
console.log('push-live: subscribe, test, reply, quiet while on screen, question, unsubscribe: all passed')
