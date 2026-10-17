// Notifications while the app is closed: this device's push subscription, its preferences, and the
// presence reports that keep a chat on screen from notifying (server/push.mjs decides the rest).

import { getState, onStateChange } from './store'

export type PushKind = 'needs' | 'replies' | 'failures' | 'tasks'
export type PushPrefs = Record<PushKind, boolean>

export const PUSH_KINDS: Array<{ kind: PushKind; label: string; hint: string }> = [
  { kind: 'needs', label: 'Hermes needs you', hint: 'Approvals, questions and passwords' },
  { kind: 'replies', label: 'A reply is ready', hint: 'When a turn finishes' },
  { kind: 'failures', label: 'A turn fails', hint: 'When a turn stops with an error' },
  { kind: 'tasks', label: 'A background task finishes', hint: 'Work a chat started and left running' }
]

export type PushSupport = 'ok' | 'install' | 'unsupported'

/** iOS delivers web notifications only to an app opened from the Home Screen. */
export function pushSupport(): PushSupport {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') {
    return 'unsupported'
  }

  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  if (ios && !standalone) {
    return 'install'
  }

  return 'PushManager' in window && 'Notification' in window ? 'ok' : 'unsupported'
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  })
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`)
  }

  return data
}

async function subscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready

  return registration.pushManager.getSubscription()
}

export interface PushState {
  permission: NotificationPermission
  subscribed: boolean
  prefs: PushPrefs
}

/** This device's current state, with the server's view of its subscription. */
export async function pushState(): Promise<PushState> {
  const current = await subscription()
  const permission = Notification.permission

  if (!current || permission !== 'granted') {
    return { permission, subscribed: false, prefs: defaults() }
  }

  const state = await post<{ subscribed: boolean; prefs: PushPrefs }>('/hm/push/state', { endpoint: current.endpoint })

  if (!state.subscribed) {
    // The server dropped it (the push service said it expired): register it again as it was.
    return enablePush(state.prefs)
  }

  return { permission, subscribed: true, prefs: state.prefs }
}

const defaults = (): PushPrefs => ({ needs: true, replies: true, failures: true, tasks: true })

/** Ask for permission (from a tap: iOS refuses otherwise) and register this device. */
export async function enablePush(prefs: PushPrefs = defaults()): Promise<PushState> {
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()

  if (permission !== 'granted') {
    return { permission, subscribed: false, prefs }
  }

  const registration = await navigator.serviceWorker.ready
  const { public_key: key } = await (await fetch('/hm/push', { headers: { accept: 'application/json' } })).json()
  let current = await registration.pushManager.getSubscription()

  // A subscription made for another server key cannot be used with this one.
  if (current && current.options.applicationServerKey && toB64u(current.options.applicationServerKey) !== key) {
    await current.unsubscribe()
    current = null
  }

  current ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) })
  const saved = await post<{ prefs: PushPrefs }>('/hm/push/subscribe', { subscription: current.toJSON(), prefs })

  return { permission, subscribed: true, prefs: saved.prefs }
}

export async function disablePush(): Promise<void> {
  const current = await subscription()

  if (current) {
    await post('/hm/push/unsubscribe', { endpoint: current.endpoint }).catch(() => undefined)
    await current.unsubscribe()
  }
}

export async function setPushPref(kind: PushKind, on: boolean): Promise<PushPrefs> {
  const current = await subscription()

  if (!current) {
    throw new Error('Notifications are off on this device.')
  }

  return (await post<{ prefs: PushPrefs }>('/hm/push/prefs', { endpoint: current.endpoint, prefs: { [kind]: on } })).prefs
}

export async function testPush(): Promise<void> {
  const current = await subscription()

  if (!current) {
    throw new Error('Notifications are off on this device.')
  }

  await post('/hm/push/test', { endpoint: current.endpoint })
}

function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '='))

  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

function toB64u(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ---------------------------------------------------------------- presence

// The server keeps a chat that is on screen here from notifying any device. Reported when the screen
// or the open chat changes, and every 20 s while the app is visible (the server forgets after 45 s,
// so an app the system froze without a word stops counting as watching).
let lastReport = ''

function report() {
  const visible = document.visibilityState === 'visible'
  const session = getState().chat.storedId
  const key = `${visible}:${session}`

  if (key === lastReport && !visible) {
    return
  }

  lastReport = key
  void fetch('/hm/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: session, visible }),
    // Going to the background, the page may be frozen before an ordinary request leaves.
    keepalive: !visible
  })
    .then(response => response.arrayBuffer())
    .catch(() => undefined)

  if (visible && session) {
    void clearChatNotifications(session)
  }
}

/** A message the phone just sent: that chat's turns notify the phone, however quick. */
export function notePhoneSent(storedId: string | null) {
  if (storedId) {
    void fetch('/hm/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: storedId, sent: true })
    })
      .then(response => response.arrayBuffer())
      .catch(() => undefined)
  }
}

/** Notifications for a chat now on screen have done their job. */
async function clearChatNotifications(storedId: string) {
  try {
    const registration = await navigator.serviceWorker.getRegistration()

    if (!registration) {
      return
    }

    for (const notification of await registration.getNotifications()) {
      if ((notification.data as { chat?: { id?: string } } | null)?.chat?.id === storedId) {
        notification.close()
      }
    }

    const left = (await registration.getNotifications()).length
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
    await (left ? nav.setAppBadge?.(left) : nav.clearAppBadge?.())
  } catch {
    // notifications are a convenience here
  }
}

export function watchPresence() {
  if (pushSupport() === 'unsupported') {
    return
  }

  document.addEventListener('visibilitychange', () => report())
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      lastReport = ''
      report()
    }
  }, 20_000)

  // The open chat changing is the other moment the server must hear about.
  let shown = getState().chat.storedId
  onStateChange(() => {
    const now = getState().chat.storedId

    if (now !== shown) {
      shown = now
      report()
    }
  })
  report()
}
