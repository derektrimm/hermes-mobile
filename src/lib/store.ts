import { useSyncExternalStore } from 'react'

import type { HandsInstance, LiveSession, Profile, SessionRow } from './api'
import type { Item } from './transcript'
import type { SessionLiveInfo, Usage } from '../../vendor/hermes-shared/gateway-contract.generated'

export type ConnState = 'connecting' | 'open' | 'reconnecting'

export interface Todo {
  text: string
  status: string
}

export interface Chat {
  /** Durable id in the session database; null until the first message creates the chat. */
  storedId: string | null
  /** The gateway runtime driving this chat from the phone; null when not attached. */
  liveId: string | null
  profile: string
  title: string
  items: Item[]
  running: boolean
  /** Transient status line while a turn runs (thinking, tool being prepared, provider notes). */
  status: string | null
  info: SessionLiveInfo | null
  usage: Usage | null
  todos: Todo[]
  /** Follow-ups sent while a turn runs: they join the transcript when Hermes starts them. */
  queued: Array<{ id: string; text: string }>
  /** The Hermes backend that owns the live chat: 'main', or 'desktop-<pid>' for the desktop app. */
  backend: string
  /** Set while the chat is live in another client the phone drives it alongside (the desktop app). */
  shared: LiveSession | null
  /** Set when the conversation is open in a process the phone cannot join: shown read-only, kept fresh. */
  watch: LiveSession | null
  /** Why the phone cannot join the PC window yet (its chat has background jobs running); null when it can. */
  held: string | null
  loading: boolean
  error: string | null
}

export type AskMethod = 'approval' | 'clarify' | 'sudo' | 'secret'

export interface Ask {
  id: string
  method: AskMethod
  params: Record<string, unknown>
  liveId: string
  backend: string
  respond: (result: Record<string, unknown>) => void
}

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'error'
  action?: { label: string; run: () => void }
}

export interface ConfirmRequest {
  title: string
  body: string
  confirm: string
  cancel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export interface State {
  conn: ConnState
  connDetail: string | null
  profiles: Profile[]
  /** Profile for new chats. */
  profile: string
  sessions: SessionRow[]
  sessionsLoaded: boolean
  live: LiveSession[]
  /** Backends running on the server right now: 'main' and 'desktop-<pid>' for each desktop app. */
  backends: string[]
  /** Stored ids of chats started on the phone (kept by the server, so every device agrees). */
  phoneChats: string[]
  /** PC-window backends set up on the server, per account. */
  hands: HandsInstance[]
  /** Gateway runtimes this phone started, resumed or joined, by stored id. */
  runtimes: Record<string, { liveId: string; profile: string; backend?: string }>
  /** Runtimes with a turn in progress (for the drawer and background-finish toasts). */
  busy: Record<string, boolean>
  chat: Chat
  asks: Ask[]
  toast: Toast | null
  drawer: boolean
  confirmRequest: ConfirmRequest | null
  /** Text a command asked to place in the composer (a "prefill" dispatch). */
  prefill: string | null
}

export function emptyChat(profile: string): Chat {
  return {
    storedId: null,
    liveId: null,
    profile,
    title: '',
    items: [],
    running: false,
    status: null,
    info: null,
    usage: null,
    todos: [],
    queued: [],
    backend: 'main',
    shared: null,
    watch: null,
    held: null,
    loading: false,
    error: null
  }
}

const PREFS_KEY = 'hermes-mobile:prefs'

interface Prefs {
  profile?: string
  runtimes?: State['runtimes']
  /** The chat on screen, so a reload or an iOS relaunch comes back to it. */
  open?: { id: string; profile: string; title: string; at: number } | null
}

function readPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Prefs
  } catch {
    return {}
  }
}

function writePrefs(state: State) {
  try {
    const { chat } = state
    const open = chat.storedId ? { id: chat.storedId, profile: chat.profile, title: chat.title, at: Date.now() } : null
    localStorage.setItem(PREFS_KEY, JSON.stringify({ profile: state.profile, runtimes: state.runtimes, open }))
  } catch {
    // private mode or storage full: preferences are a convenience
  }
}

const prefs = readPrefs()

// Coming back within this long (a reload, iOS evicting the app in the background) reopens the chat
// you were in; after longer the app starts on a new chat.
const RESTORE_WITHIN_MS = 30 * 60_000

export const restoreChat =
  prefs.open && Date.now() - prefs.open.at < RESTORE_WITHIN_MS ? { id: prefs.open.id, profile: prefs.open.profile, title: prefs.open.title } : null

/** Stamp the open chat as just seen (called when the app goes to the background). */
export function rememberOpenChat() {
  writePrefs(state)
}

let state: State = {
  conn: 'connecting',
  connDetail: null,
  profiles: [],
  profile: prefs.profile || 'default',
  sessions: [],
  sessionsLoaded: false,
  live: [],
  backends: ['main'],
  phoneChats: [],
  hands: [],
  runtimes: prefs.runtimes || {},
  busy: {},
  chat: emptyChat(prefs.profile || 'default'),
  asks: [],
  toast: null,
  drawer: false,
  confirmRequest: null,
  prefill: null
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

export function setState(update: Partial<State> | ((s: State) => Partial<State>)) {
  const patch = typeof update === 'function' ? update(state) : update
  const next = { ...state, ...patch }

  if (
    patch.profile !== undefined ||
    patch.runtimes !== undefined ||
    next.chat.storedId !== state.chat.storedId ||
    next.chat.title !== state.chat.title
  ) {
    writePrefs(next)
  }

  state = next
  listeners.forEach(listener => listener())
}

export function setChat(update: Partial<Chat> | ((c: Chat) => Partial<Chat>)) {
  setState(s => ({ chat: { ...s.chat, ...(typeof update === 'function' ? update(s.chat) : update) } }))
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state))
}

let toastSeq = 0

export function toast(text: string, tone: Toast['tone'] = 'info', action?: Toast['action']) {
  const id = ++toastSeq
  setState({ toast: { id, text, tone, action } })
  setTimeout(() => {
    if (state.toast?.id === id) {
      setState({ toast: null })
    }
  }, action ? 6000 : 3500)
}

/** An in-app confirmation sheet (never the browser's native dialog). */
export function confirmAction(request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  state.confirmRequest?.resolve(false)

  return new Promise(resolve => {
    setState({
      confirmRequest: {
        ...request,
        resolve: ok => {
          setState({ confirmRequest: null })
          resolve(ok)
        }
      }
    })
  })
}
