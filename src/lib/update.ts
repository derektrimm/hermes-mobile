import { getState, toast } from './store'

// A home-screen app can stay alive for days with the code it booted. Each deploy changes the hashed
// script the page loads, so compare ours with the server's when the app comes back to the
// foreground (and now and then while it stays open), and pick up a new build. The open chat and any
// unsent text come back after the reload, so nothing is lost.
const ours = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null

async function serverBuild(): Promise<string | null> {
  try {
    const html = await (await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } })).text()

    return html.match(/<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/)?.[1] ?? null
  } catch {
    return null
  }
}

let offered = false

async function check(reloadNow: boolean) {
  if (!ours) {
    return
  }

  const latest = await serverBuild()

  if (!latest || latest === ours) {
    return
  }

  // Coming back to the app is the moment nobody is mid-sentence: reload unless a turn is streaming
  // into the open chat right now, which would only flicker.
  if (reloadNow && !getState().chat.running) {
    location.reload()

    return
  }

  if (!offered) {
    offered = true
    toast('Hermes has an update.', 'info', { label: 'Reload', run: () => location.reload() })
  }
}

export function watchForUpdates() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void check(true)
    }
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      void check(false)
    }
  }, 10 * 60_000)
}
