// Live check (spends one short turn): a chat open in an older PC window, with nothing running there.
// Opening it on the phone must not touch the window; the first message sent from the phone makes the
// window shared and goes out, with no button. Usage: node test/e2e/autoshare-live.mjs "<chat title>"
import { BASE, chromium, devices } from './env.mjs'

const title = process.argv[2]

if (!title) {
  console.error('usage: node test/e2e/autoshare-live.mjs "<title of a chat open in an older PC window>"')
  process.exit(2)
}

const OUT = process.env.HM_SHOTS || `${process.env.TMPDIR || '/tmp'}/`
const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'], colorScheme: 'dark' })
const page = await context.newPage()
const errors = []
const shares = []
page.on('pageerror', e => errors.push(String(e)))
page.on('request', r => r.url().includes('/hm/share') && shares.push(r.url()))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.querySelector('.conn-banner'), null, { timeout: 15000 })
await page.click('button[aria-label="Chats"]')
const row = page.locator('.row', { hasText: title }).filter({ has: page.locator('.tag') }).first()
await row.waitFor({ timeout: 15000 })
// Only an older window is shown by reading its stored messages (a shared one is joined live).
// Anything else is a chat this test must not type into: stop before sending.
const watched = page.waitForRequest(r => /\/api\/sessions\/[^/]+\/messages/.test(r.url()), { timeout: 8000 }).then(() => true, () => false)
await row.click()
await page.waitForSelector('.destination', { timeout: 15000 })

if (!(await watched)) {
  console.error('That chat is not in an older PC window (it is shared or not open on the PC); not sending anything.')
  await browser.close()
  process.exit(3)
}

await page.waitForTimeout(3000)
console.log('window untouched by opening:', shares.length === 0)
const t0 = Date.now()
await page.fill('.composer textarea', 'Use your terminal tool to run exactly: uname -n   then reply with that one output line only')
await page.click('button[aria-label="Send"]')
await page.waitForSelector('.send.stop', { timeout: 120000 })
console.log(`joined and sent in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 120000 })
console.log('answer:', JSON.stringify(await page.locator('.msg.assistant').last().innerText()))
await page.screenshot({ path: `${OUT}autoshare-answered.png` })
console.log('errors', JSON.stringify(errors))
await browser.close()
