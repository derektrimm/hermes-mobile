// Attachments and steering against the real Hermes backend, in a throwaway chat deleted at the end
// (two short model turns): a text file attached from the phone is read by the model, and a word
// steered into a running turn reaches its answer.
import assert from 'node:assert/strict'

import { BASE, chromium, devices } from './env.mjs'

const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'], colorScheme: 'dark' })
const page = await context.newPage()
// A throwaway chat is not a real phone chat: keep it out of the server's list.
await page.route('**/hm/phone-chat', route => route.fulfill({ json: { ok: true } }))
const errors = []
page.on('pageerror', e => errors.push(String(e)))

const lastReply = () => page.locator('.msg.assistant').last().innerText()
const turnDone = () => page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 180_000 })
let stored = null

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => !document.querySelector('.conn-banner'), null, { timeout: 15000 })

  // 1. A file from the phone reaches the model.
  await page.setInputFiles('.composer input[type=file]', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('The secret word is lighthouse.\n') })
  await page.fill('.composer textarea', 'Read the attached file and reply with only its secret word, nothing else.')
  await page.click('button[aria-label="Send"]')
  await page.waitForSelector('.send.stop', { timeout: 30_000 })
  await turnDone()
  assert.match(await lastReply(), /lighthouse/i)
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('hermes-mobile:prefs') || '{}').open)
  console.log('1 ok: the attached file was read by the model')

  // 2. A word steered into a running turn reaches its answer.
  await page.fill('.composer textarea', 'Use your terminal tool to run `sleep 20`. When it finishes, reply with only the word I send you while it runs.')
  await page.click('button[aria-label="Send"]')
  await page.waitForFunction(() => document.querySelector('.work, .step') !== null, null, { timeout: 90_000 })
  await page.fill('.composer textarea', 'The word is banana.')
  await page.click('.followup-mode >> text=Steer now')
  await page.click('button[aria-label="Steer"]')
  await page.waitForFunction(() => [...document.querySelectorAll('.notice')].some(n => n.textContent.includes('Steered: The word is banana.')))
  await turnDone()
  assert.match(await lastReply(), /banana/i)
  console.log('2 ok: the steer reached the running turn')
} finally {
  stored ??= await page.evaluate(() => JSON.parse(localStorage.getItem('hermes-mobile:prefs') || '{}').open).catch(() => null)

  if (stored?.id) {
    const status = await page.evaluate(
      ({ id, profile }) => fetch(`/api/sessions/${encodeURIComponent(id)}?profile=${encodeURIComponent(profile)}`, { method: 'DELETE' }).then(r => r.status),
      stored
    )
    console.log(`throwaway chat ${stored.id} deleted: HTTP ${status}`)
  }

  await browser.close()
}

assert.deepEqual(errors, [])
