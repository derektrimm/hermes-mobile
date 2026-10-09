// Live check (no turn spent): a chat open in an older PC window that has background jobs running
// there. Opening it must not touch the window, and a message sent from the phone must be refused
// with the reason, the text staying in the composer.
// Usage: node test/e2e/held-live.mjs "<chat title>"
import { BASE, chromium, devices } from './env.mjs'

const title = process.argv[2]

if (!title) {
  console.error('usage: node test/e2e/held-live.mjs "<title of a chat whose older PC window has background jobs running>"')
  process.exit(2)
}

const OUT = process.env.HM_SHOTS || `${process.env.TMPDIR || '/tmp'}/`
const browser = await chromium.launch()
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'], colorScheme: 'dark' })
const page = await context.newPage()
const errors = []
const shares = []
page.on('pageerror', e => errors.push(String(e)))
page.on('response', r => r.url().includes('/hm/share') && r.text().then(t => shares.push(`${r.status()} ${t}`)))

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
await page.fill('.composer textarea', 'test text that must stay put')
await page.click('button[aria-label="Send"], button[aria-label="Send follow-up"]')
await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === 'test text that must stay put' && document.querySelector('.destination')?.textContent?.includes('would stop'), null, { timeout: 30000 })
console.log('refused with:', JSON.stringify(await page.locator('.destination').innerText()))
console.log('text kept:', JSON.stringify(await page.locator('.composer textarea').inputValue()))
await page.screenshot({ path: `${OUT}held.png` })
await page.fill('.composer textarea', '')
console.log('share answers:', JSON.stringify(shares))
console.log('errors', JSON.stringify(errors))
await browser.close()
