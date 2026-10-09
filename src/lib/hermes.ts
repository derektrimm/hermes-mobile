// The phone's connection to Hermes: gateway sockets (through the app's server), the event
// reducer that turns the agent's stream into the transcript, and every action the UI can take.

import { api, HttpError, type SessionRow } from './api'
import { type Ask, type AskMethod, type Chat, confirmAction, emptyChat, getState, rememberOpenChat, restoreChat, setChat, setState, type State, toast } from './store'
import { drafts, saveDraft } from './drafts'
import { SERVER } from './site'
import { displayTitle } from './format'
import { modelLabel } from './labels'
import { argsContext, contentText, fromStored, fromTranscript, type Item, localId, type ToolItem, toolFailed, userContent } from './transcript'
import type {
  CommandDispatchResult,
  CommandsCatalogResult,
  SessionActiveListResult,
  SessionEventsSinceResult,
  ConfigSetResult,
  ModelOptionsResult,
  PromptSubmitParams,
  PromptSubmitStatus,
  SessionCreateResult,
  SessionResumeResult,
  SlashExecResult
} from '../../vendor/hermes-shared/gateway-contract.generated'
import type { GatewayEvent } from '../../vendor/hermes-shared/gateway-events'
import type { ServerRequest } from '../../vendor/hermes-shared/json-rpc-channel'
import { JsonRpcGatewayClient } from '../../vendor/hermes-shared/json-rpc-gateway'

const MAIN = 'main'
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ---------------------------------------------------------------- connections

// One socket per Hermes backend on the server. 'main' is the machine-level backend (new phone chats,
// history, lists); 'desktop-<pid>' is the desktop app's own backend, joined to drive the chats that
// are live there. A live chat can only be driven through the process that owns it.
class Gateway {
  readonly client = new JsonRpcGatewayClient({
    closedErrorMessage: 'Connection to Hermes closed',
    connectErrorMessage: 'Could not reach Hermes',
    notConnectedErrorMessage: 'Not connected to Hermes yet',
    requestTimeoutMs: 120_000
  })

  attempt = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private opened = false
  private closed = false
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = []

  constructor(readonly key: string) {
    this.client.onState(next => {
      if (next === 'open') {
        this.attempt = 0
        const reconnected = this.opened
        this.opened = true
        this.waiters.splice(0).forEach(w => {
          clearTimeout(w.timer)
          w.resolve()
        })
        reportConn(this.key, 'open')
        void onGatewayOpen(this.key, reconnected)
      } else if ((next === 'closed' || next === 'error') && !this.closed) {
        reportConn(this.key, 'reconnecting')
        this.scheduleReconnect()
      }
    })
    this.client.onEvent(event => onGatewayEvent(this.key, event))
    this.client.onRequest(request => onGatewayRequest(this.key, request))
  }

  get state() {
    return this.client.connectionState
  }

  url() {
    const query = this.key === MAIN ? '' : `?backend=${encodeURIComponent(this.key)}`

    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws${query}`
  }

  async connect() {
    clearTimeout(this.retry)

    if (this.closed || this.state === 'open' || this.state === 'connecting') {
      return
    }

    reportConn(this.key, this.opened ? 'reconnecting' : 'connecting')

    try {
      await this.client.connect(this.url())
    } catch {
      this.scheduleReconnect()
    }
  }

  scheduleReconnect() {
    clearTimeout(this.retry)
    const delay = Math.min(15_000, 600 * 2 ** Math.min(this.attempt, 5)) * (0.75 + Math.random() * 0.5)
    this.attempt += 1
    this.retry = setTimeout(() => void this.connect(), delay)

    if (this.key !== MAIN && this.attempt >= 3) {
      void backendLost(this.key)
    }
  }

  wake() {
    if (this.state !== 'open') {
      this.attempt = 0
      void this.connect()

      return
    }

    // After a sleep iOS may have killed the socket without a close: prove it is alive within 3 s,
    // or drop it now so the first send does not wait out the heartbeat.
    this.client.request('gateway.ping', {}, 3000).catch(() => this.client.invalidate('No answer after waking'))
  }

  ready(timeoutMs = 20_000): Promise<void> {
    if (this.state === 'open') {
      return Promise.resolve()
    }

    void this.connect()

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter(w => w !== waiter)
          reject(new Error('Hermes is not reachable right now'))
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  close() {
    this.closed = true
    clearTimeout(this.retry)
    this.waiters.splice(0).forEach(w => {
      clearTimeout(w.timer)
      w.reject(new Error('Connection closed'))
    })
    this.client.close()
  }
}

const gateways = new Map<string, Gateway>()

function gateway(key = MAIN): Gateway {
  let g = gateways.get(key)

  if (!g) {
    g = new Gateway(key)
    gateways.set(key, g)
    void g.connect()
  }

  return g
}

/**
 * Drop desktop and PC backend sockets nothing here needs any more (the phone stops being a viewer
 * there). A socket stays while the open chat lives on it, while a chat the phone follows on it is
 * still working, or while one of its questions is waiting for an answer: closing it would cut off
 * that turn's progress, its questions and its finish.
 */
function releaseUnusedGateways() {
  const { chat, runtimes, busy, asks } = getState()
  const needed = new Set([chat.backend, ...asks.map(a => a.backend)])

  for (const runtime of Object.values(runtimes)) {
    const key = runtime.backend ?? MAIN

    if (busy[busyKey(key, runtime.liveId)]) {
      needed.add(key)
    }
  }

  for (const [key, g] of gateways) {
    if (key !== MAIN && !needed.has(key)) {
      g.close()
      gateways.delete(key)
    }
  }
}

async function rpcOn<T>(key: string, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  const g = gateway(key)
  await g.ready()

  return g.client.request<T>(method, params, timeoutMs)
}

/** A call for the open chat, on the backend that owns it. */
function rpc<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  return rpcOn<T>(getState().chat.backend, method, params, timeoutMs)
}

function reportConn(key: string, conn: State['conn']) {
  if (key === getState().chat.backend || (key === MAIN && !gateways.has(getState().chat.backend))) {
    setState({ conn })
  }
}

// A phone that sleeps or changes networks keeps a dead socket that reports nothing; waking up is
// the moment to check it. The client's own heartbeat closes a silently dead socket within ~45 s.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    gateways.forEach(g => g.wake())
    void refreshSessions()
    void refreshLive().then(() => watchReload?.())
  } else {
    rememberOpenChat()
  }
})
window.addEventListener('online', () => gateways.forEach(g => g.wake()))

let restored = false

async function onGatewayOpen(key: string, reconnected: boolean) {
  if (key === MAIN) {
    void refreshProfiles()
    const sessions = refreshSessions()
    void refreshLive()

    // First connection after a launch: reopen the chat that was on screen, if it still exists and
    // nothing else has been opened meanwhile.
    if (!restored && restoreChat) {
      restored = true
      const target = restoreChat
      await sessions
      const { chat, sessions: rows } = getState()

      if (!chat.storedId && !chat.items.length && rows.some(row => row.id === target.id && row.profile === target.profile)) {
        void openSession(target)
      }
    }
  }

  if (!reconnected) {
    return
  }

  // A dropped socket was detached from every session it followed. Questions come back with the
  // re-join (open_requests), so the old cards go; then every session this phone follows on this
  // backend is re-joined: the open chat with a repaint, the others (running, or waiting on an
  // answer) quietly, so their progress and questions keep reaching the phone.
  setState(s => ({ asks: s.asks.filter(a => a.backend !== key) }))
  const { chat, runtimes, busy } = getState()

  if (chat.backend === key && chat.storedId && !chat.watch) {
    // The client replays what was missed, and holds back live frames that race that replay, then
    // delivers both marked as replayed (which this app skips: the re-join below repaints instead).
    // Re-joining only after that has drained means the snapshot is taken after every skipped frame,
    // and everything that follows it arrives live.
    const settled = chat.liveId ? await gateway(key).client.sessionReplayBarrier(chat.liveId) : true

    if (settled === false) {
      return // the socket dropped again; the next open re-joins
    }

    await attach(captureTarget(), { quiet: true })
  }

  for (const runtime of Object.values(runtimes)) {
    if ((runtime.backend ?? MAIN) === key && busy[busyKey(key, runtime.liveId)] && runtime.liveId !== getState().chat.liveId) {
      void rpcOn(key, 'session.activate', { session_id: runtime.liveId, omit_messages: true }).catch(() => forgetRuntime(runtime.liveId))
    }
  }
}

/** The desktop app's backend is gone (the app quit): leave the chat readable, never silently move it. */
async function backendLost(key: string) {
  const chat = getState().chat

  if (chat.backend !== key || !chat.storedId) {
    return
  }

  await refreshLive()

  if (getState().backends.includes(key)) {
    return // only this socket is struggling; it keeps retrying
  }

  gateways.get(key)?.close()
  gateways.delete(key)

  // Another chat may have been opened while the live list was read: only the chat that was on
  // this backend is moved.
  const now = getState().chat

  if (now.backend !== key || now.storedId !== chat.storedId) {
    return
  }

  // A backend that restarted comes back under a new key (they are named by process): the chat is
  // still open on the PC, now there. Join it again rather than move it to the server.
  const again = liveElsewhere(chat.storedId, chat.profile)

  if ((again?.holder === 'pc-shared' || again?.holder === 'desktop-app') && again.backend && again.backend !== key) {
    forgetRuntime(chat.liveId ?? '')
    setChat({ backend: again.backend, shared: again, liveId: null })
    await attach(captureTarget(), { quiet: true })

    return
  }

  const fromPc = now.shared?.holder === 'pc-shared' || key.startsWith('pc-')
  setChat({ backend: MAIN, shared: null, liveId: null, running: false, status: null })
  pushNotice(
    fromPc
      ? `The PC window backend stopped. Send a message to continue this chat on ${SERVER}, where its tools will run.`
      : `The desktop app closed. Send a message to continue this chat on ${SERVER}, where its tools will run.`,
    'warn'
  )
  // The chat now goes through the server's main connection: show that connection's state, so the send
  // the notice asks for is not refused as offline.
  reportConn(MAIN, gateway(MAIN).state === 'open' ? 'open' : 'reconnecting')
}

export function start() {
  gateway(MAIN)
}

// ---------------------------------------------------------------- lists

export async function refreshProfiles() {
  try {
    const profiles = await api.profiles()
    setState(s => ({
      profiles,
      profile: profiles.some(p => p.name === s.profile) ? s.profile : profiles.find(p => p.is_default)?.name || 'default'
    }))
  } catch (error) {
    console.warn('profiles', error)
  }
}

let sessionsInflight: Promise<void> | null = null

export function refreshSessions(): Promise<void> {
  sessionsInflight ??= (async () => {
    try {
      const names = getState().profiles.map(p => p.name)
      const lists = await Promise.allSettled((names.length ? names : ['default']).map(name => api.sessions(name)))
      const rows = lists.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
      rows.sort((a, b) => activity(b) - activity(a))
      setState({ sessions: rows, sessionsLoaded: true })
    } finally {
      sessionsInflight = null
    }
  })()

  return sessionsInflight
}

const activity = (row: SessionRow) => row.last_activity_at || row.started_at || 0

let sessionsTimer: ReturnType<typeof setTimeout> | undefined

function refreshSessionsSoon() {
  clearTimeout(sessionsTimer)
  sessionsTimer = setTimeout(() => void refreshSessions(), 1200)
}

export async function refreshLive() {
  try {
    const { sessions, backends, phone_chats } = await api.live()
    setState(s => ({ live: sessions, backends, phoneChats: phone_chats ?? s.phoneChats }))
  } catch (error) {
    console.warn('live', error)
  }
}

/** Who else has this conversation open right now (null when nobody, or only this phone's backend). */
export function liveElsewhere(storedId: string, profile: string) {
  return (
    getState().live.find(
      l => l.session_id === storedId && (l.profile === profile || l.profile === null) && l.holder !== 'phone-backend'
    ) ?? null
  )
}

// ---------------------------------------------------------------- opening chats

let openSeq = 0
let watchTimer: ReturnType<typeof setInterval> | undefined
let watchReload: (() => Promise<void>) | null = null

function stopWatching() {
  clearInterval(watchTimer)
  watchTimer = undefined
  watchReload = null
}

/**
 * What an operation acts on, captured when it starts. Every await can land after the user opened
 * another chat; the operation keeps acting on its own chat and only paints the screen if that chat
 * is still the one open (seq matches).
 */
interface Target {
  seq: number
  backend: string
  profile: string
  storedId: string | null
  liveId: string | null
}

function captureTarget(): Target {
  const { chat } = getState()

  return { seq: openSeq, backend: chat.backend, profile: chat.profile, storedId: chat.storedId, liveId: chat.liveId }
}

const onScreen = (target: Target) => target.seq === openSeq

export function newChat(profile = getState().profile) {
  stopWatching()
  openSeq += 1
  pendingModel = null
  pendingEffort = null
  setState({ chat: emptyChat(profile), drawer: false, profile })
  releaseUnusedGateways()
  reportConn(MAIN, gateway(MAIN).state === 'open' ? 'open' : 'reconnecting')
}

export async function openSession(row: { id: string; profile: string; title?: string | null }) {
  stopWatching()
  const seq = ++openSeq
  pendingModel = null
  pendingEffort = null
  setState({
    drawer: false,
    chat: { ...emptyChat(row.profile), storedId: row.id, title: row.title || '', loading: true }
  })

  await refreshLive()

  if (seq !== openSeq) {
    return
  }

  const holder = liveElsewhere(row.id, row.profile)

  if ((holder?.holder === 'desktop-app' || holder?.holder === 'pc-shared') && holder.backend) {
    // Live in the desktop app or a PC window's TUI: join that very session in the backend that
    // owns it and drive it alongside.
    setChat({ backend: holder.backend, shared: holder })
    releaseUnusedGateways()
    await attach(captureTarget())
  } else if (holder) {
    // Open somewhere the phone cannot join yet (an older PC window): show it live. Reading never
    // disturbs that window; the first message sent from here makes it shared (autoShare).
    releaseUnusedGateways()
    await watch(row.id, row.profile, seq)
  } else {
    // Not open anywhere: the phone resumes it on the server's backend. A chat that ran in a PC window
    // or the desktop app had its commands run on the PC; from here they run on the server, so say so.
    const source = getState().sessions.find(s => s.id === row.id && s.profile === row.profile)?.source ?? ''
    const fresh = !getState().runtimes[row.id]
    releaseUnusedGateways()
    const liveId = await attach(captureTarget())

    if (liveId && fresh && seq === openSeq && ['cli', 'tui', 'desktop'].includes(source) && !getState().phoneChats.includes(row.id)) {
      pushNotice(`Picked up on ${SERVER}: commands in this chat now run on ${SERVER}.`, 'info')
    }
  }
}

// Live events that arrive while a snapshot is being fetched: applied on top of it afterwards, so a
// delta streamed during the fetch is neither lost (snapshot read before it) nor doubled.
let attaching: { backend: string; events: GatewayEvent[] } | null = null

/** Join or resume the target chat on its backend and return the backend's view of it. */
async function joinRuntime(target: Target): Promise<SessionResumeResult> {
  if (!target.storedId) {
    throw new Error('Nothing to open')
  }

  if (target.backend !== MAIN) {
    const list = await rpcOn<SessionActiveListResult>(target.backend, 'session.active_list', {})
    const live = list.sessions.find(item => item.session_key === target.storedId)

    if (!live) {
      throw new Error('This chat is no longer open on the PC.')
    }

    // One more client of the session the desktop app shows: activate never displaces the others.
    return rpcOn<SessionResumeResult>(target.backend, 'session.activate', { session_id: live.id })
  }

  const known = getState().runtimes[target.storedId]

  // Two accounts can hold the same stored id (a copied profile): only reuse a runtime of this one.
  if (known && (known.backend ?? MAIN) === MAIN && known.profile === target.profile) {
    try {
      return await rpcOn<SessionResumeResult>(MAIN, 'session.activate', { session_id: known.liveId, profile: target.profile })
    } catch {
      // the runtime was reaped or the backend restarted: resume from the stored conversation
    }
  }

  return rpcOn<SessionResumeResult>(MAIN, 'session.resume', {
    session_id: target.storedId,
    profile: target.profile,
    close_on_disconnect: false
  })
}

/** Drive the target chat from the phone; paints it when it is still the chat on screen. */
async function attach(target: Target, opts: { quiet?: boolean } = {}): Promise<string | null> {
  const buffer = onScreen(target) ? { backend: target.backend, events: [] as GatewayEvent[] } : null

  if (buffer) {
    attaching = buffer
  }

  let result: SessionResumeResult

  try {
    result = await joinRuntime(target)
  } catch (error) {
    if (attaching === buffer) {
      attaching = null
    }

    if (onScreen(target)) {
      setChat({ loading: false, error: errorText(error) })
    }

    return null
  } finally {
    if (attaching === buffer) {
      attaching = null
    }
  }

  const profile = result.info?.profile_name || target.profile
  rememberRuntime(target.storedId as string, result.session_id, profile, target.backend)

  if (onScreen(target)) {
    if (profile !== getState().chat.profile) {
      setChat({ profile })
    }

    applySnapshot(target.backend, result)
    replayBuffered(target.backend, result, buffer?.events ?? [])
  }

  if (!opts.quiet) {
    void refreshLive()
  }

  return result.session_id
}

function rememberRuntime(storedId: string, liveId: string, profile: string, backend = MAIN) {
  setState(s => {
    const runtimes = { ...s.runtimes, [storedId]: { liveId, profile, backend } }
    // Keep the map small: the newest 40 chats.
    const keys = Object.keys(runtimes)

    for (const key of keys.slice(0, Math.max(0, keys.length - 40))) {
      delete runtimes[key]
    }

    return { runtimes }
  })
}

function forgetRuntime(liveId: string) {
  setState(s => {
    const runtimes = { ...s.runtimes }

    for (const [storedId, runtime] of Object.entries(runtimes)) {
      if (runtime.liveId === liveId) {
        delete runtimes[storedId]
      }
    }

    return { runtimes }
  })
}

function applySnapshot(backend: string, result: SessionResumeResult) {
  const items = fromTranscript(result.messages || [])
  const inflight = result.inflight

  // The turn in flight, or a turn that failed while this phone was away (Hermes keeps it for the
  // reconnect): its partial answer and its error belong on screen either way.
  if (inflight) {
    if (inflight.user && !items.some(i => i.kind === 'user' && i.text === inflight.user)) {
      items.push({ kind: 'user', id: localId('u'), text: inflight.user })
    }

    if (inflight.assistant) {
      items.push({ kind: 'assistant', id: localId('a'), text: inflight.assistant, streaming: Boolean(result.running) })
    }

    if (inflight.error) {
      items.push({ kind: 'notice', id: localId('n'), text: String(inflight.error), tone: 'error' })
    }
  }

  setChat(c => ({
    liveId: result.session_id,
    backend,
    storedId: result.stored_session_id || result.session_key || c.storedId,
    title: result.info?.title || c.title,
    info: result.info ?? c.info,
    usage: (result.info?.usage as Chat['usage']) ?? c.usage,
    items,
    queued: result.queued?.user ? [{ id: localId('q'), text: String(result.queued.user) }] : [],
    running: Boolean(result.running),
    status: result.running ? 'Working…' : null,
    todos: todosFrom(result.todo_state?.todos),
    watch: null,
    loading: false,
    error: null
  }))
  setState(s => ({ busy: { ...s.busy, [busyKey(backend, result.session_id)]: Boolean(result.running) } }))
  // A snapshot leaves open_requests out when there are none: that means every question was answered.
  reconcileAsks(backend, result.session_id, result.open_requests ?? [])
}

/** Apply events that arrived during the snapshot fetch, skipping what the snapshot already holds. */
function replayBuffered(backend: string, result: SessionResumeResult, events: GatewayEvent[]) {
  const mine = events.filter(e => e.session_id === result.session_id)
  const snapshot = result.running ? result.inflight?.assistant ?? '' : ''
  const textOf = (event: GatewayEvent) => String((event.payload as { text?: string } | undefined)?.text ?? '')

  // Deltas that arrived while the snapshot was being taken may already be in its partial answer:
  // the ones from before that moment are the latest chunks it ends with. Skip the longest leading
  // run of buffered deltas whose joined text the snapshot ends with; failing that, trim the first
  // delta by its longest prefix the snapshot ends with (a chunk split across the snapshot).
  let lead = 0

  while (lead < mine.length && mine[lead].type === 'message.delta') {
    lead++
  }

  let skip = 0
  let trimFirst = 0

  if (snapshot && lead) {
    for (let k = lead; k > 0 && !skip; k--) {
      if (snapshot.endsWith(mine.slice(0, k).map(textOf).join(''))) {
        skip = k
      }
    }

    if (!skip) {
      const first = textOf(mine[0])

      for (let k = Math.min(first.length, snapshot.length); k > 0; k--) {
        if (snapshot.endsWith(first.slice(0, k))) {
          trimFirst = k
          break
        }
      }
    }
  }

  mine.forEach((event, i) => {
    if (i < skip) {
      return
    }

    if (i === 0 && trimFirst) {
      const keep = textOf(event).slice(trimFirst)

      if (keep) {
        applyEvent(backend, { ...event, payload: { ...(event.payload as object), text: keep } } as GatewayEvent)
      }

      return
    }

    if (event.type === 'tool.start' && getState().chat.items.some(it => it.kind === 'tool' && it.id === String((event.payload as { tool_id?: string })?.tool_id))) {
      return
    }

    applyEvent(backend, event)
  })
}

/** Read-only view of a conversation another Hermes process is driving; refreshed every 3 s. */
async function watch(storedId: string, profile: string, seq: number) {
  const load = async () => {
    try {
      const messages = await api.messages(profile, storedId)

      if (seq !== openSeq) {
        return
      }

      const holder = liveElsewhere(storedId, profile)

      // The window became joinable (made shared, or the chat moved to the desktop app): join it, and
      // send whatever was typed here meanwhile.
      if ((holder?.holder === 'pc-shared' || holder?.holder === 'desktop-app') && holder.backend && !sharing.has(storedId)) {
        stopWatching()
        await joinAndFlush({ ...captureTarget(), storedId, profile })

        return
      }

      const items = fromStored(messages)
      // A turn in flight leaves a user or tool row, or an assistant row asking for tools, as the last
      // stored message (the same reading the server uses before it restarts a PC window). A turn that
      // died part-way leaves the same shape, so only a recent one counts.
      const last = messages[messages.length - 1]
      const midTurn = Boolean(last && (last.role === 'user' || last.role === 'tool' || (last.role === 'assistant' && last.tool_calls?.length)))
      const recent = Boolean(last?.timestamp && Date.now() / 1000 - last.timestamp < 30 * 60)
      const working = Boolean(holder && midTurn && recent)
      setChat({
        items,
        watch: holder,
        running: working,
        status: working ? (holder?.holder === 'pc-window' ? 'Working on your PC' : `Working in ${holder?.holder_label}`) : null,
        loading: false,
        error: null
      })

      if (!holder) {
        stopWatching()
      }
    } catch (error) {
      if (seq === openSeq) {
        setChat({ loading: false, error: errorText(error) })
      }
    }
  }

  setChat({ watch: liveElsewhere(storedId, profile) })
  watchReload = load
  await load()

  if (seq === openSeq && getState().chat.watch) {
    watchTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshLive().then(load)
      }
    }, 3000)
  }
}

// A chat open in an older PC window (the classic CLI) is made shared as soon as it is opened here:
// the server restarts that window in place as a client of the shared backend (same chat, window stays
// open), then the phone joins it. Mid-turn it waits for the turn to end, retrying quietly.
// Chats being joined right now, one join per chat (several PC windows can join side by side).
const sharing = new Set<string>()

async function autoShare(target: Target) {
  if (!target.storedId || sharing.has(target.storedId) || !onScreen(target)) {
    return
  }

  sharing.add(target.storedId)

  try {
    const result = await api.share(target.storedId, target.profile)

    if (!result.ok) {
      throw new Error(result.error || 'Could not reach the PC window')
    }
  } catch (error) {
    sharing.delete(target.storedId)
    const body = error instanceof HttpError ? (error.body as { busy?: boolean; jobs?: number; draft?: boolean; pinned?: boolean } | null) : null

    if (onScreen(target)) {
      if (body?.jobs || body?.draft || body?.pinned) {
        // Joining would restart the window and end its jobs or lose what is typed there: the PC keeps
        // the chat for now. Anything typed meanwhile goes back to the composer rather than waiting in
        // a queue for who knows how long.
        const waiting = getState().chat.queued.map(q => q.text).join('\n\n')
        const why = body.jobs ? `${errorText(error)} Reply in the PC window for now, or send again here once they finish.` : errorText(error)
        setChat({ held: why, queued: [] })

        if (waiting) {
          setState({ prefill: waiting })
        }
      } else if (body?.busy) {
        setChat({ held: null })
      } else if (getState().chat.queued.length) {
        toast(`Could not reach the PC window yet: ${errorText(error)}. Trying again.`, 'error')
      }

      // A window is only ever restarted for a message sent from here: keep trying while one waits
      // (a turn ending, a hiccup), never on its own.
      if (getState().chat.queued.length) {
        setTimeout(() => void autoShare(target), body?.busy ? 5000 : 15_000)
      }
    }

    return
  }

  sharing.delete(target.storedId)

  if (onScreen(target)) {
    setChat({ held: null })
  }

  if (!onScreen(target)) {
    return
  }

  await joinAndFlush(target)
}

/**
 * Open the target chat on the backend that now holds it, then send what was typed while the phone
 * was joining: to this chat only. If another chat was opened during the join, it waits as this
 * chat's draft instead.
 */
async function joinAndFlush(target: Target) {
  if (!target.storedId) {
    return
  }

  const waiting = getState().chat.storedId === target.storedId ? getState().chat.queued.map(q => q.text) : []
  const title = getState().chat.title
  await openSession({ id: target.storedId, profile: target.profile, title })

  if (waiting.length && getState().chat.storedId !== target.storedId) {
    const key = target.storedId
    saveDraft(key, [drafts.get(key), ...waiting].filter(Boolean).join('\n\n'))
    toast(`Not sent: you opened another chat. It is saved as a draft in ${displayTitle(title)}.`)

    return
  }

  for (const text of waiting) {
    if (getState().chat.storedId !== target.storedId) {
      saveDraft(target.storedId, [drafts.get(target.storedId), text].filter(Boolean).join('\n\n'))
      continue
    }

    await send(text)
  }
}

/** Let go of the phone's runtime so a PC window can resume the conversation. */
export async function releaseToPc() {
  const { chat } = getState()

  if (!chat.liveId || chat.backend !== MAIN) {
    return
  }

  try {
    await rpcOn(MAIN, 'session.close', { session_id: chat.liveId })
  } catch (error) {
    toast(errorText(error), 'error')

    return
  }

  forgetRuntime(chat.liveId)
  setChat({ liveId: null })
  toast(`Released. On the PC: hermes -p ${chat.profile} --resume ${chat.storedId}`)
}

// ---------------------------------------------------------------- sending

// A model or effort picked on a chat that does not exist yet is created with it on the first message.
let pendingModel: { provider: string; model: string } | null = null
let pendingEffort: string | null = null
const effortToApply = new Map<string, { effort: string; profile: string }>()

export function pendingModelChoice() {
  return pendingModel
}

export function pendingEffortChoice() {
  return pendingEffort
}

const effortReads = new Map<string, { at: number; value: string | null }>()

/**
 * The effort a chat runs with when its live info does not say: the chat's own pin for a live chat
 * (config.get with its session), else its account's default. Read fresh each minute, since either
 * can change on the desktop.
 */
export async function defaultEffort(profile: string, liveId?: string | null, backend = MAIN): Promise<string | null> {
  if (!profile) {
    return null
  }

  const key = `${backend}:${profile}:${liveId ?? ''}`
  const cached = effortReads.get(key)

  if (cached && Date.now() - cached.at < 60_000) {
    return cached.value
  }

  const result = await rpcOn<{ value?: string | null }>(backend, 'config.get', {
    key: 'reasoning',
    profile,
    ...(liveId ? { session_id: liveId } : {})
  }).catch(() => null)
  const value = result?.value || null
  effortReads.set(key, { at: Date.now(), value })

  return value
}

/** Set this chat's reasoning effort (session scope: the profile default is never rewritten). */
export async function setEffort(effort: string): Promise<boolean> {
  const target = captureTarget()

  if (!target.liveId && !target.storedId) {
    pendingEffort = effort
    setState(s => ({ ...s }))

    return true
  }

  try {
    const liveId = await ensureRuntime(target)
    const result = await rpcOn<{ value?: string }>(target.backend, 'config.set', {
      session_id: liveId,
      profile: target.profile,
      key: 'reasoning',
      value: effort
    })
    effortToApply.set(busyKey(target.backend, liveId), { effort, profile: target.profile })
    effortReads.clear()

    if (onScreen(target)) {
      setChat(c => ({ info: { ...(c.info ?? {}), reasoning_effort: result?.value || effort } }))
    }

    return true
  } catch (error) {
    toast(errorText(error), 'error')

    return false
  }
}

/** The runtime the target chat is driven through, creating or joining it as needed. */
/**
 * Where a stored chat with no runtime here is live right now, checked at the moment it is needed:
 * a chat shown as "not open anywhere" can have been opened (or re-opened) in a PC window or the
 * desktop app since. Joinable holders are joined (the target and the screen move to that backend);
 * 'window' means an older PC window holds it, which only a message sent from here may convert.
 */
async function routeStored(target: Target): Promise<'here' | 'joined' | 'window'> {
  if (!target.storedId || target.liveId || target.backend !== MAIN) {
    return 'here'
  }

  await refreshLive()
  const holder = liveElsewhere(target.storedId, target.profile)

  if (!holder) {
    return 'here'
  }

  if ((holder.holder === 'pc-shared' || holder.holder === 'desktop-app') && holder.backend) {
    target.backend = holder.backend

    if (onScreen(target)) {
      setChat({ backend: holder.backend, shared: holder, watch: null })
    }

    return 'joined'
  }

  if (onScreen(target)) {
    setChat({ watch: holder })
  }

  return 'window'
}

async function ensureRuntime(target: Target): Promise<string> {
  if (target.liveId) {
    return target.liveId
  }

  if (target.storedId) {
    // Never resume on garrison a chat that is open in a PC window or the desktop app: that makes
    // a second live copy, the window stops seeing the chat, and commands run in the wrong place.
    if ((await routeStored(target)) === 'window') {
      throw new Error('This chat is open in a PC window. Send a message here to join it.')
    }

    const liveId = await attach(target, { quiet: true })

    if (!liveId) {
      throw new Error((onScreen(target) && getState().chat.error) || 'Could not open this chat')
    }

    return liveId
  }

  const wanted = pendingModel
  const effort = pendingEffort
  const created = await rpcOn<SessionCreateResult>(MAIN, 'session.create', {
    profile: target.profile,
    close_on_disconnect: false,
    ...(wanted ? { model: wanted.model, provider: wanted.provider } : {}),
    ...(effort ? { reasoning_effort: effort } : {})
  })

  if (wanted && pendingModel === wanted) {
    pendingModel = null
  }

  if (effort && pendingEffort === effort) {
    pendingEffort = null
  }

  if (effort) {
    effortToApply.set(busyKey(MAIN, created.session_id), { effort, profile: target.profile })
  }

  rememberRuntime(created.stored_session_id, created.session_id, target.profile, MAIN)
  setState(s => ({ phoneChats: [...s.phoneChats, created.stored_session_id] }))
  void api.phoneChat(created.stored_session_id).catch(error => console.warn('phone chat', error))

  if (onScreen(target)) {
    setChat({ liveId: created.session_id, storedId: created.stored_session_id, info: created.info })
  }

  refreshSessionsSoon()

  return created.session_id
}

export interface Attachment {
  name: string
  dataUrl: string
}

/**
 * Send a message to the chat on screen, or to `given` (a chat captured earlier, e.g. by a slash
 * command whose expansion arrives after the user moved on): it goes to that chat either way.
 */
export async function send(text: string, attachments: Attachment[] = [], given?: Target): Promise<boolean> {
  const trimmed = text.trim()

  if (!trimmed && !attachments.length) {
    return false
  }

  if (trimmed.startsWith('/') && !attachments.length && !given) {
    return slash(trimmed)
  }

  const target = given ?? captureTarget()
  const visible = onScreen(target)

  // A chat with no runtime here: check where it is live before anything is sent (see routeStored).
  if (visible && target.storedId && !target.liveId && !getState().chat.watch) {
    await routeStored(target)
  }

  // Still joining a PC window: the message waits and is sent once the phone is in. Photos cannot
  // wait in that queue, so they stay in the composer until the phone has joined.
  if (visible && getState().chat.watch) {
    if (attachments.length) {
      toast('Photos can go once the phone has joined this chat. They are still in the composer.', 'info')

      return false
    }

    setChat(c => ({ queued: [...c.queued, { id: localId('q'), text: trimmed }] }))

    if (getState().chat.watch?.holder === 'pc-window') {
      void autoShare(target)
    }

    return true
  }

  const queuing = visible && getState().chat.running
  const localKey = localId(queuing ? 'q' : 'u')

  // In a chat shared with a PC window, a text message is typed into that window, so it shows there
  // as typed and runs as the window's own prompt; the phone then sees that turn like any turn typed
  // on the PC. When typing is not safe the server says so and the message goes the usual way.
  if (visible && target.storedId && getState().chat.shared?.holder === 'pc-shared' && !attachments.length) {
    const typed = await api.typeInWindow(target.storedId, trimmed, queuing).catch(() => null)

    if (typed?.typed && onScreen(target)) {
      if (typed.queued) {
        setChat(c => ({ queued: [...c.queued, { id: localKey, text: trimmed }] }))
      } else {
        setChat(c => ({
          items: [...c.items, { kind: 'user', id: localKey, text: trimmed }],
          running: true,
          status: 'Thinking…'
        }))
      }

      if (typed.stuck) {
        toast('Your message is in the PC window but did not send. Press Enter there.', 'error')
      }

      return true
    }
  }

  // A follow-up sent mid-turn waits beside the transcript until Hermes starts it, so the answer
  // still streaming stays one piece.
  if (!visible) {
    // Not on screen: nothing to paint; the chat shows the message when it is opened.
  } else if (queuing) {
    setChat(c => ({ queued: [...c.queued, { id: localKey, text: trimmed }] }))
  } else {
    setChat(c => ({
      items: [...c.items, { kind: 'user', id: localKey, text: trimmed, images: attachments.map(a => a.dataUrl), pending: true }]
    }))
  }

  const uploaded: string[] = []
  let liveId: string | null = null

  const upload = async (id: string) => {
    for (const attachment of attachments) {
      const result = await rpcOn<{ path?: string | null }>(target.backend, 'image.attach_bytes', {
        session_id: id,
        profile: target.profile,
        content_base64: attachment.dataUrl.split(',')[1],
        filename: attachment.name
      })

      if (result?.path) {
        uploaded.push(result.path)
      }
    }
  }

  try {
    liveId = await ensureRuntime(target)

    // Pictures attached to a chat wait on the session, not on a device, and the next prompt from any
    // device takes them all. In a chat shared with the PC, a picture pasted there and not sent yet
    // would ride along with this message: ask first (detaching a path nobody staged changes nothing
    // and reports how many are waiting).
    if (target.backend !== MAIN) {
      const staged = await rpcOn<{ count?: number }>(target.backend, 'image.detach', {
        session_id: liveId,
        profile: target.profile,
        path: '(hermes-mobile: count only)'
      }).catch(() => null)

      if (staged?.count) {
        throw new Error('A picture is waiting in the message box on your PC. Send that first, then this.')
      }
    }

    await upload(liveId)

    const params: PromptSubmitParams = { session_id: liveId, profile: target.profile, text: trimmed }

    // With photos attached Hermes prefixes the prompt with a note about them; title the chat
    // from what was actually typed instead.
    if (attachments.length) {
      params.title_preview = trimmed || (attachments.length === 1 ? 'Photo' : `${attachments.length} photos`)
    }

    // Always "run after", never a live correction: with the chat shared, the PC can start a turn a
    // moment before the phone hears of it, and Hermes's default for an unmarked message that lands
    // mid-turn is to interrupt that turn. On an idle chat the flag changes nothing.
    params.queued = true

    const submit = () =>
      rpcOn<{ status?: PromptSubmitStatus | null }>(target.backend, 'prompt.submit', params as unknown as Record<string, unknown>)
    let result: { status?: PromptSubmitStatus | null }

    try {
      result = await submit()
    } catch (error) {
      if (!runtimeGone(error)) {
        throw error
      }

      // The backend reaped or replaced this runtime (idle, restart, closed in the desktop app):
      // re-join once, re-stage the photos, and send again.
      forgetRuntime(liveId)

      if (onScreen(target)) {
        setChat({ liveId: null })
      }

      await refreshLive()
      const holder = target.storedId ? liveElsewhere(target.storedId, target.profile) : null
      const joinable = holder?.backend && (holder.holder === 'desktop-app' || holder.holder === 'pc-shared') ? holder.backend : null

      // A chat that ran on the PC or in the desktop app and is no longer open there would continue on
      // the server, with its commands running there instead. That is never done silently for a message
      // written for the PC: stop, keep the text, and say what the next send will do.
      if (!joinable && target.backend !== MAIN) {
        if (onScreen(target)) {
          setChat({ backend: MAIN, shared: null, running: false, status: null })
          pushNotice(`This chat is no longer open on your PC. Send again to continue it on ${SERVER}, where its commands will run.`, 'warn')
        }

        throw new Error('Not sent: the chat is no longer open on your PC.')
      }

      const retarget = { ...target, liveId: null, backend: joinable ?? MAIN }

      if (joinable && onScreen(target)) {
        setChat({ backend: joinable, shared: holder })
      }

      liveId = await ensureRuntime(retarget)
      target.backend = retarget.backend
      uploaded.length = 0
      await upload(liveId)
      params.session_id = liveId
      result = await submit()
    }

    if (!onScreen(target)) {
      toast('Sent to the chat you left')

      return true
    }

    if (queuing && result.status === 'steered') {
      setChat(c => ({ queued: c.queued.filter(q => q.id !== localKey) }))
      pushNotice('Sent to the running turn as a correction.', 'info')
    } else if (queuing && result.status !== 'queued') {
      // The turn ended while this was in flight: it starts now as a turn of its own.
      admitQueued(localKey)
      setChat({ running: true, status: 'Thinking…' })
    } else if (!queuing && result.status === 'queued') {
      // A turn was already running (started elsewhere a moment ago): this waits for it, like any follow-up.
      setChat(c => ({
        items: c.items.filter(i => i.id !== localKey),
        queued: [...c.queued, { id: localKey, text: trimmed }],
        running: true,
        status: c.status || 'Working…'
      }))
    } else if (!queuing) {
      markUser(localKey, { pending: false })
      setChat({ running: true, status: 'Thinking…' })
    }

    return true
  } catch (error) {
    // Photos staged before the failure would ride along with the next prompt: take them back.
    for (const path of uploaded) {
      void rpcOn(target.backend, 'image.detach', { session_id: liveId, profile: target.profile, path }).catch(() => undefined)
    }

    if (onScreen(target)) {
      setChat(c => ({ items: c.items.filter(i => i.id !== localKey), queued: c.queued.filter(q => q.id !== localKey) }))
    }

    toast(errorText(error), 'error')

    return false
  }
}

/** The runtime an RPC named no longer exists on its backend. */
function runtimeGone(error: unknown) {
  const code = (error as { code?: number })?.code
  const message = errorText(error)

  return code === 4007 || code === 4001 || /no longer live|session not found|unknown session/i.test(message)
}

/** Move a queued follow-up into the transcript: Hermes has started it. */
function admitQueued(id?: string) {
  setChat(c => {
    if (id) {
      const next = c.queued.find(q => q.id === id)

      return next ? { queued: c.queued.filter(q => q.id !== id), items: [...c.items, { kind: 'user', id: next.id, text: next.text }] } : {}
    }

    // Hermes joins text follow-ups queued back to back into one prompt (session_auto_continue.py,
    // _enqueue_prompt), so the turn that starts runs all of them: show them as that one message.
    if (!c.queued.length) {
      return {}
    }

    return {
      queued: [],
      items: [...c.items, { kind: 'user', id: c.queued[0].id, text: c.queued.map(q => q.text).join('\n\n') }]
    }
  })
}

function markUser(id: string, patch: Partial<Item>) {
  setChat(c => ({ items: c.items.map(i => (i.id === id ? ({ ...i, ...patch } as Item) : i)) }))
}

function pushNotice(text: string, tone: 'info' | 'warn' | 'error', output = false) {
  setChat(c => ({ items: [...c.items, { kind: 'notice', id: localId('n'), text, tone, ...(output ? { output } : {}) }] }))
}

export async function stop() {
  const target = captureTarget()

  if (!target.liveId) {
    return
  }

  try {
    await rpcOn(target.backend, 'session.interrupt', { session_id: target.liveId, profile: target.profile })

    if (onScreen(target)) {
      // Stop also drops the follow-ups waiting behind the turn (session_lifecycle.py clears the
      // queue): they were never sent, so they go back into the composer rather than vanish.
      const waiting = getState().chat.queued.map(q => q.text)
      setChat({ status: 'Stopping…', queued: [] })

      if (waiting.length) {
        setState({ prefill: waiting.join('\n\n') })
        toast(waiting.length === 1 ? 'Your queued message is back in the box.' : 'Your queued messages are back in the box.')
      }
    }
  } catch (error) {
    toast(errorText(error), 'error')
  }
}

interface DispatchLike {
  type?: string | null
  output?: string | null
  display?: string | null
  notice?: string | null
  message?: string | null
  warning?: string | null
}

// Commands the phone runs itself, the way the desktop app routes them (apps/src/lib/
// desktop-slash-commands.ts): through the slash worker these act on a side copy of the chat, so
// /btw and /bg answers would never arrive and /reasoning or /yolo would not reach the live chat.
const EFFORT_WORDS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

async function slash(command: string): Promise<boolean> {
  const target = captureTarget()
  const [head, ...rest] = command.slice(1).split(/\s+/)
  const name = `/${head.toLowerCase()}`
  const arg = rest.join(' ').trim()

  switch (name) {
    case '/new':
    case '/reset':
    case '/clear':
      newChat(target.profile)

      return true
    case '/stop':
      await stop()

      return true
    case '/title':
      if (!arg) {
        toast('Add the new name, like /title Release notes.', 'info')

        return false
      }

      await renameChat(arg)

      return true
    case '/model':
      toast('Pick a model from the menu under the chat title.', 'info')

      return false
  }

  try {
    const liveId = await ensureRuntime(target)

    if (name === '/reasoning' && EFFORT_WORDS.has(arg.toLowerCase())) {
      return setEffort(arg.toLowerCase())
    }

    if (name === '/yolo' || name === '/reasoning') {
      const result = await rpcOn<{ value?: string }>(target.backend, 'config.set', {
        session_id: liveId,
        profile: target.profile,
        key: name.slice(1),
        value: arg
      })

      if (onScreen(target)) {
        pushNotice(
          name === '/yolo'
            ? result?.value === '1' || result?.value === 'on'
              ? 'Auto-approve is on for this chat: risky commands run without asking.'
              : 'Auto-approve is off for this chat.'
            : `Reasoning ${arg || 'setting'}: ${result?.value ?? 'done'}`,
          'info'
        )
      }

      return true
    }

    if (name === '/btw' || name === '/bg' || name === '/background') {
      if (!arg) {
        toast(name === '/btw' ? 'Add the question, like /btw what changed in auth?' : 'Add the task, like /bg run the full test suite.', 'info')

        return false
      }

      await rpcOn(target.backend, name === '/btw' ? 'prompt.btw' : 'prompt.background', { session_id: liveId, profile: target.profile, text: arg })

      if (onScreen(target)) {
        pushNotice(name === '/btw' ? `Side question: ${arg}` : `Running in the background: ${arg}`, 'info')
      }

      return true
    }

    if (name === '/compress' || name === '/compact') {
      if (onScreen(target)) {
        setChat({ status: 'Compressing the conversation…' })
      }

      await rpcOn(target.backend, 'session.compress', { session_id: liveId, profile: target.profile, ...(arg ? { focus_topic: arg } : {}) }, 300_000)

      if (onScreen(target)) {
        setChat({ status: null })
        pushNotice('Conversation compressed.', 'info')
      }

      return true
    }

    let result: DispatchLike

    try {
      result = await rpcOn<SlashExecResult>(target.backend, 'slash.exec', {
        session_id: liveId,
        command: command.slice(1),
        profile: target.profile
      })
    } catch (error) {
      // Skills and a few built-ins answer "use command.dispatch" (4018), as the desktop app handles it.
      if ((error as { code?: number }).code !== 4018) {
        throw error
      }

      result = await rpcOn<CommandDispatchResult>(target.backend, 'command.dispatch', {
        name: head,
        arg: rest.join(' ') || null,
        session_id: liveId,
        profile: target.profile
      })
    }

    if ((result.type === 'send' || result.type === 'skill') && result.message) {
      return send(result.message, [], target)
    }

    if (result.type === 'prefill' && result.message) {
      if (onScreen(target)) {
        setState({ prefill: result.message })
      } else if (target.storedId) {
        saveDraft(target.storedId, result.message)
      }

      return true
    }

    const text = [result.output, result.display, result.notice, result.message, result.warning]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .join('\n\n')

    if (onScreen(target)) {
      pushNotice(text || `Ran /${head}`, result.warning ? 'warn' : 'info', Boolean(text))
    }

    return true
  } catch (error) {
    toast(errorText(error), 'error')

    return false
  }
}

// Skills differ per account and per backend: one catalog each.
const catalogs = new Map<string, CommandsCatalogResult>()

export async function commandCatalog(): Promise<Array<{ name: string; description: string }>> {
  const { backend, profile } = getState().chat
  const key = `${backend}:${profile}`
  let catalog = catalogs.get(key)

  if (!catalog) {
    catalog = await rpc<CommandsCatalogResult>('commands.catalog', { profile })
    catalogs.set(key, catalog)
  }

  const meta = catalog.commands || {}

  // Hermes marks commands that only work in a terminal (redraw, $EDITOR compose, quit...) the same
  // way the desktop app reads them; the phone hides those too.
  return (catalog.pairs || [])
    .filter(pair => pair[0]?.startsWith('/'))
    .filter(([name]) => !['terminal', 'hidden'].includes(meta[name]?.desktop ?? ''))
    .map(([name, description]) => ({ name, description: description || '' }))
}

export async function modelOptions(): Promise<ModelOptionsResult> {
  const { chat } = getState()

  return rpc<ModelOptionsResult>('model.options', {
    profile: chat.profile,
    ...(chat.liveId ? { session_id: chat.liveId } : {})
  })
}

/** Switch this chat's model (session scope only: the profile default is never rewritten). */
export async function switchModel(provider: string, model: string): Promise<boolean> {
  const target = captureTarget()

  if (!target.liveId && !target.storedId) {
    pendingModel = { provider, model }
    setState(st => ({ ...st }))

    return true
  }

  try {
    const liveId = await ensureRuntime(target)
    const apply = (confirm: boolean) =>
      rpcOn<ConfigSetResult>(target.backend, 'config.set', {
        session_id: liveId,
        profile: target.profile,
        key: 'model',
        value: `${model} --provider ${provider} --session`,
        ...(confirm ? { confirm_expensive_model: true } : {})
      })

    let result = await apply(false)

    if (result.confirm_required) {
      const ok = await confirmAction({
        title: `Switch to ${model}?`,
        body: result.confirm_message || `${model} costs more per turn than the current model.`,
        confirm: 'Switch model',
        cancel: 'Keep the current model'
      })

      if (!ok) {
        return false
      }

      result = await apply(true)
    }

    if (result.info && onScreen(target)) {
      setChat({ info: result.info })
    }

    toast(result.deferred ? `Switches to ${modelLabel(model)} on the next turn` : `Now using ${modelLabel(model)}`)

    return true
  } catch (error) {
    toast(errorText(error), 'error')

    return false
  }
}

export async function renameChat(title: string) {
  const { chat } = getState()

  if (!chat.storedId || !title.trim()) {
    return
  }

  try {
    await api.rename(chat.profile, chat.storedId, title.trim())
    setChat({ title: title.trim() })
    void refreshSessions()
  } catch (error) {
    toast(errorText(error), 'error')
  }
}

export async function deleteChat(row: { id: string; profile: string }) {
  await refreshLive()
  const holder = liveElsewhere(row.id, row.profile)

  if (holder) {
    toast(`This chat is open in ${holder.holder_label}. Close it there first.`, 'error')

    return
  }

  try {
    const runtime = getState().runtimes[row.id]

    // Only a runtime this phone owns on the machine-level backend is closed; a viewer never closes.
    if (runtime && (runtime.backend ?? MAIN) === MAIN && runtime.profile === row.profile) {
      await rpcOn(MAIN, 'session.close', { session_id: runtime.liveId }).catch(() => undefined)
    }

    await api.remove(row.profile, row.id)
    setState(s => {
      const runtimes = { ...s.runtimes }
      delete runtimes[row.id]

      return { runtimes, sessions: s.sessions.filter(r => !(r.id === row.id && r.profile === row.profile)) }
    })

    if (getState().chat.storedId === row.id) {
      newChat(row.profile)
    }
  } catch (error) {
    toast(errorText(error), 'error')
  }
}

// ---------------------------------------------------------------- questions from the agent

const ASKS: AskMethod[] = ['approval', 'clarify', 'sudo', 'secret']

function onGatewayRequest(backend: string, request: ServerRequest): boolean {
  if (!ASKS.includes(request.method as AskMethod)) {
    // Requests only a desktop window can serve (its terminal, preview, vault). In a chat the
    // desktop app also shows, step aside without settling it, so the desktop app answers; in a
    // chat only this phone drives, fail it now rather than leave the agent waiting.
    if (backend !== MAIN && request.decline) {
      request.decline('Not shown on the phone')

      return true
    }

    return false
  }

  const liveId = String(request.params.session_id || '')
  const ask: Ask = {
    id: request.id,
    method: request.method as AskMethod,
    params: request.params,
    liveId,
    backend,
    respond: result => {
      request.respond(result)
      setState(s => ({ asks: s.asks.filter(a => a.id !== request.id) }))
    }
  }

  setState(s => ({ asks: [...s.asks.filter(a => a.id !== request.id), ask] }))

  if (!isOpenChat(backend, liveId) && !request.replayed) {
    toast(`${titleFor(liveId)} needs your answer`, 'info', { label: 'Open', run: () => void openByLiveId(liveId) })
  }

  return true
}

/** Drop question cards the backend no longer has open (answered in another client). */
function reconcileAsks(backend: string, liveId: string, open: unknown) {
  if (!Array.isArray(open)) {
    return
  }

  const ids = new Set(open.map(entry => (entry as { id?: string })?.id).filter(Boolean))
  setState(s => ({ asks: s.asks.filter(a => !(a.backend === backend && a.liveId === liveId && !ids.has(a.id))) }))
}

// Progress in a session whose question is still on screen means it may have been answered
// elsewhere: ask the backend which questions are still open. A long approved command sends no
// progress at all, so a shown question is also re-checked every few seconds.
setInterval(() => {
  if (document.visibilityState !== 'visible') {
    return
  }

  for (const key of new Set(getState().asks.map(a => `${a.backend}\u0000${a.liveId}`))) {
    const [backend, liveId] = key.split('\u0000')
    checkAsksSoon(backend, liveId)
  }
}, 4000)

const askChecks = new Map<string, ReturnType<typeof setTimeout>>()

function checkAsksSoon(backend: string, liveId: string) {
  const key = `${backend}:${liveId}`

  if (askChecks.has(key) || !getState().asks.some(a => a.backend === backend && a.liveId === liveId)) {
    return
  }

  askChecks.set(
    key,
    setTimeout(() => {
      askChecks.delete(key)
      void rpcOn<SessionEventsSinceResult>(backend, 'session.events.since', {
        session_id: liveId,
        last_seen: gateway(backend).client.getSeqWatermarks()[liveId] ?? null
      })
        .then(result => reconcileAsks(backend, liveId, result.open_requests))
        .catch(() => undefined)
    }, 600)
  )
}

function isOpenChat(backend: string, liveId: string | undefined) {
  const { chat } = getState()

  return Boolean(liveId) && chat.liveId === liveId && chat.backend === backend
}

function storedIdFor(liveId: string) {
  return Object.entries(getState().runtimes).find(([, r]) => r.liveId === liveId)?.[0] ?? null
}

function titleFor(liveId: string) {
  const storedId = storedIdFor(liveId)

  return getState().sessions.find(s => s.id === storedId)?.title || 'A Hermes chat'
}

export async function openByLiveId(liveId: string) {
  const storedId = storedIdFor(liveId)
  const runtime = storedId ? getState().runtimes[storedId] : null

  if (storedId && runtime) {
    await openSession({ id: storedId, profile: runtime.profile, title: titleFor(liveId) })
  }
}

// ---------------------------------------------------------------- the event stream

function todosFrom(raw: unknown): Chat['todos'] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .map(t => {
      const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>

      return { text: String(o.content ?? o.text ?? o.title ?? ''), status: String(o.status ?? 'pending') }
    })
    .filter(t => t.text)
}

/** The assistant item a delta continues: the last item, if it is an assistant item still streaming. */
function openAssistant(items: Item[]): number {
  const last = items.length - 1

  return last >= 0 && items[last].kind === 'assistant' && items[last].streaming ? last : -1
}

function closeAssistant(items: Item[]): Item[] {
  return items.map(i => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i))
}

function appendAssistant(items: Item[], field: 'text' | 'reasoning', delta: string): Item[] {
  const index = openAssistant(items)
  const copy = items.slice()

  if (index < 0) {
    copy.push({ kind: 'assistant', id: localId('a'), text: field === 'text' ? delta : '', reasoning: field === 'reasoning' ? delta : undefined, streaming: true })
  } else {
    const item = copy[index] as Extract<Item, { kind: 'assistant' }>
    copy[index] = { ...item, [field]: (item[field] || '') + delta }
  }

  return copy
}

/** Index where the running turn began (after the last user message). */
/**
 * Fill in the prompt of a turn started on another device. The live session knows it (the snapshot's
 * inflight prompt); the stored conversation is the fallback.
 */
async function readPeerPrompt(target: Target, itemId: string) {
  if (!target.storedId) {
    return
  }

  const startedAt = Date.now() / 1000
  let text = ''

  try {
    if (target.liveId) {
      const live = await rpcOn<SessionResumeResult>(target.backend, 'session.activate', { session_id: target.liveId, omit_messages: true })
      text = live.inflight?.user ? userContent(live.inflight.user).text : ''
    }

    if (!text) {
      const rows = await api.messages(target.profile, target.storedId)
      const row = [...rows].reverse().find(r => r.role === 'user' && r.display_kind !== 'hidden')

      if (row && (!row.timestamp || row.timestamp >= startedAt - 120)) {
        text = userContent(row.display_content ?? row.content).text
      }
    }
  } catch (error) {
    console.warn('peer prompt', error)
  }

  if (!text || !onScreen(target)) {
    return
  }

  // A goal or loop continuation starts a turn with no new prompt: the latest prompt is then the one
  // already on screen, and the marker stays empty.
  const shown = getState().chat.items.filter(i => i.kind === 'user' && i.id !== itemId).pop()

  if (shown?.kind === 'user' && shown.text === text) {
    return
  }

  setChat(c => ({ items: c.items.map(i => (i.id === itemId && i.kind === 'user' ? { ...i, text } : i)) }))
}

function turnStart(items: Item[]) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user') {
      return i + 1
    }
  }

  return 0
}

/** Attach reasoning to the turn's newest assistant item, creating one when none exists yet. */
function withReasoning(items: Item[], text: string): Item[] {
  const copy = items.slice()

  for (let i = copy.length - 1; i >= turnStart(copy); i--) {
    const item = copy[i]

    if (item.kind === 'tool') {
      break
    }

    if (item.kind === 'assistant') {
      if (!item.reasoning?.trim() && text.trim() !== item.text.trim()) {
        copy[i] = { ...item, reasoning: text }
      }

      return copy
    }
  }

  copy.push({ kind: 'assistant', id: localId('a'), text: '', reasoning: text })

  return copy
}

function toolOutput(result: unknown, fallback?: string | null): string | null {
  if (typeof result === 'string') {
    return result
  }

  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    const parts = [r.output, r.content, r.error].filter((v): v is string => typeof v === 'string' && v.length > 0)

    if (parts.length) {
      return parts.join('\n')
    }
  }

  return fallback ?? null
}

function onGatewayEvent(backend: string, event: GatewayEvent) {
  const sid = event.session_id
  const payload = (event.payload ?? {}) as Record<string, unknown>

  // Another client (the desktop app, a second phone tab) answered a question first, or the agent
  // withdrew it: its card goes away here too.
  if (event.type === 'request.cancel') {
    setState(s => ({ asks: s.asks.filter(a => a.id !== payload.id) }))

    return
  }

  // Lifecycle broadcasts carry their session inside the payload, not on the envelope.
  if (event.type === 'session.reclaimed') {
    reclaimed(backend, String(payload.session_id || ''), String(payload.stored_session_id || ''), String(payload.reason || ''))

    return
  }

  // An effort picked before Hermes has built the chat's agent is not final yet: session.create
  // applies it without storing it, and a reopened chat's first build restores the effort stored
  // with it over a fresh pick (tui_gateway/server.py, _deferred_build_agent_kwargs). At the start of
  // the next turn the agent exists, so setting it again then reaches the agent and is stored.
  if (event.type === 'message.start' && sid && effortToApply.has(busyKey(backend, sid))) {
    const pick = effortToApply.get(busyKey(backend, sid))!
    effortToApply.delete(busyKey(backend, sid))
    void rpcOn(backend, 'config.set', { session_id: sid, profile: pick.profile, key: 'reasoning', value: pick.effort }).catch(() => undefined)
  }

  if (event.type === 'approval.cancelled') {
    const ids = new Set((payload.request_ids as string[] | undefined) || [])
    const live = String(payload.session_id || sid || '')
    setState(s => ({
      asks: s.asks.filter(
        a => !(a.backend === backend && a.method === 'approval' && (ids.has(String(a.params.request_id)) || (ids.size === 0 && a.liveId === live)))
      )
    }))

    return
  }

  if (!sid) {
    if (event.type === 'sessions.changed') {
      refreshSessionsSoon()
    }

    return
  }

  trackBackground(backend, event)

  // A followed chat on a desktop or PC backend finished: its socket may no longer be needed.
  if (event.type === 'message.complete' && backend !== MAIN) {
    queueMicrotask(releaseUnusedGateways)
  }

  if (sid) {
    checkAsksSoon(backend, sid)
  }

  // A reconnect is followed by session.activate, which repaints the open chat from the
  // backend's own state, so replayed frames would only double what that snapshot shows.
  if (event.replayed) {
    return
  }

  if (attaching?.backend === backend) {
    attaching.events.push(event)

    return
  }

  if (isOpenChat(backend, sid)) {
    applyEvent(backend, event)
  }
}

function reclaimed(backend: string, liveId: string, storedId: string, reason: string) {
  forgetRuntime(liveId)
  const { chat } = getState()

  if (chat.backend === backend && (chat.liveId === liveId || (storedId && chat.storedId === storedId))) {
    setChat({ liveId: null, running: false, status: null })
    // Hermes reclaims a runtime for idleness or to make room (session_lifecycle.py: idle_timeout,
    // lru_evict, ws_orphan_reap); the chat itself is saved and a send picks it up again.
    pushNotice(
      reason === 'idle_timeout' || reason === 'lru_evict' || reason === 'ws_orphan_reap'
        ? 'Hermes put this chat to sleep while it sat idle. Sending a message wakes it.'
        : 'This chat was closed where it was running. Sending a message opens it again here.',
      'info'
    )
    void refreshLive().then(() => rehome(backend, chat.storedId, chat.profile))
  }
}

/** After a desktop or PC runtime went away: follow the chat to where it is open now, or say it moves. */
function rehome(backend: string, storedId: string | null, profile: string) {
  const now = getState().chat

  if (backend === MAIN || !storedId || now.storedId !== storedId || now.backend !== backend) {
    return
  }

  const again = liveElsewhere(storedId, profile)

  if ((again?.holder === 'pc-shared' || again?.holder === 'desktop-app') && again.backend) {
    setChat({ backend: again.backend, shared: again })

    return
  }

  setChat({ backend: MAIN, shared: null })
  pushNotice(`This chat is no longer open on your PC. Sending continues it on ${SERVER}, where its commands will run.`, 'warn')
}

export const busyKey = (backend: string, liveId: string) => `${backend}:${liveId}`

function trackBackground(backend: string, event: GatewayEvent) {
  const sid = event.session_id as string
  const key = busyKey(backend, sid)

  if (event.type === 'message.start') {
    setState(s => ({ busy: { ...s.busy, [key]: true } }))
  } else if (event.type === 'message.complete') {
    const wasBusy = getState().busy[key]
    setState(s => ({ busy: { ...s.busy, [key]: false } }))

    if (wasBusy && !isOpenChat(backend, sid)) {
      toast(`${titleFor(sid)} finished`, 'info', { label: 'Open', run: () => void openByLiveId(sid) })
    }

    refreshSessionsSoon()
  } else if (event.type === 'session.title') {
    const payload = event.payload as { session_id?: string; title?: string } | undefined

    if (payload?.title) {
      const storedId = payload.session_id || storedIdFor(sid)
      setState(s => ({ sessions: s.sessions.map(r => (r.id === storedId ? { ...r, title: payload.title } : r)) }))
    }
  }
}

function applyEvent(backend: string, event: GatewayEvent) {
  const payload = (event.payload ?? {}) as Record<string, unknown>

  switch (event.type) {
    case 'message.start': {
      const { chat } = getState()

      if (!chat.running && chat.queued.length) {
        // A turn starting after the last one finished is the follow-up queued from here.
        admitQueued()
      } else if (!chat.running && chat.items[chat.items.length - 1]?.kind !== 'user') {
        // Nobody here sent this turn: it was typed on the PC or in the desktop app. Hermes sends no
        // prompt with message.start, but stores it on accepting it; mark the turn boundary now (so
        // the answer is not folded into the previous one) and read the prompt back.
        const id = localId('u')
        setChat(c => ({ items: [...c.items, { kind: 'user', id, text: '', peer: true }] }))
        void readPeerPrompt(captureTarget(), id)
      }

      setChat({ running: true, status: 'Thinking…' })
      break
    }

    case 'thinking.delta':
      setChat({ status: cleanStatus(String(payload.text || '')) || 'Thinking…' })
      break

    case 'status.update':
      if (payload.text) {
        setChat({ status: cleanStatus(String(payload.text)) })
      }

      break

    case 'reasoning.delta':
      setChat(c => ({ items: appendAssistant(c.items, 'reasoning', String(payload.text || '')) }))
      break

    case 'reasoning.available':
      setChat(c => ({ items: withReasoning(c.items, String(payload.text || '')) }))
      break

    case 'message.delta':
      setChat(c => ({ items: appendAssistant(c.items, 'text', String(payload.text || '')), status: null }))
      break

    case 'message.interim':
      setChat(c => ({
        items: payload.already_streamed
          ? closeAssistant(c.items)
          : [...closeAssistant(c.items), { kind: 'assistant', id: localId('a'), text: String(payload.text || '') }]
      }))
      break

    case 'tool.generating':
      setChat({ status: `Preparing ${friendlyTool(String(payload.name || ''))}…` })
      break

    case 'tool.start': {
      const tool: ToolItem = {
        kind: 'tool',
        id: String(payload.tool_id),
        name: String(payload.name || 'tool'),
        context: (payload.context as string | null) || argsContext(payload.args),
        status: 'running'
      }

      setChat(c => ({ items: [...closeAssistant(c.items), tool], status: null }))
      break
    }

    case 'tool.complete':
      setChat(c => ({
        items: c.items.map(i =>
          i.kind === 'tool' && i.id === String(payload.tool_id)
            ? {
                ...i,
                status: toolFailed(payload.result) ? 'error' : 'done',
                duration: (payload.duration_s as number | null) ?? null,
                output: toolOutput(payload.result, (payload.result_text as string | null) || (payload.summary as string | null))
              }
            : i
        )
      }))
      break

    case 'todo.updated':
      setChat({ todos: todosFrom(payload.todos) })
      break

    case 'session.info':
      setChat(c => ({ info: payload as Chat['info'], title: (payload.title as string) || c.title }))
      break

    case 'session.usage':
      setChat({ usage: payload.usage as Chat['usage'] })
      break

    case 'session.title':
      setChat({ title: String(payload.title || '') })
      break

    case 'message.complete':
      completeTurn(backend, payload)
      break

    case 'btw.complete':
    case 'background.complete': {
      // A /btw side question or a /bg task finished: its answer, apart from the conversation.
      const heading = event.type === 'btw.complete' ? 'Side answer' : 'Background task finished'
      const question = typeof payload.question === 'string' && payload.question ? ` (${payload.question})` : ''
      setChat(c => ({
        items: [...c.items, { kind: 'assistant', id: localId('a'), text: `**${heading}**${question}\n\n${contentText(payload.text)}` }]
      }))
      break
    }

    case 'error':
      pushNotice(String(payload.message || 'Something went wrong'), 'error')
      break

    case 'notice':
      if (payload.message) {
        pushNotice(String(payload.message), 'info')
      }

      break

    default:
      break
  }
}

/**
 * The turn's authoritative end. The final answer is shown exactly once: as streamed, as an interim
 * the user already saw (response_previewed), or added here when it was never streamed after the
 * last tool; a transformed answer replaces what streamed.
 */
function completeTurn(backend: string, payload: Record<string, unknown>) {
  // Stopped (here or on the PC): Hermes dropped the follow-ups queued behind the turn, so the phone's
  // queued messages were never sent; they go back into the composer.
  if (payload.status === 'interrupted' && getState().chat.queued.length) {
    const waiting = getState().chat.queued.map(q => q.text)
    setChat({ queued: [] })
    setState({ prefill: waiting.join('\n\n') })
    toast(waiting.length === 1 ? 'Stopped. Your queued message is back in the box.' : 'Stopped. Your queued messages are back in the box.')
  }

  // A desktop chat joined before its first message had no profile; it is stored now.
  if (!getState().chat.profile) {
    const storedId = getState().chat.storedId
    void refreshLive().then(() => {
      const named = getState().live.find(l => l.session_id === storedId)?.profile

      if (named && getState().chat.storedId === storedId && getState().chat.backend === backend) {
        setChat({ profile: named })
      }
    })
  }

  setChat(c => {
    let items = closeAssistant(c.items)
    const start = turnStart(items)
    const finalText = contentText(payload.text) || (typeof payload.rendered === 'string' ? payload.rendered : '')
    let lastTool = -1

    for (let i = items.length - 1; i >= start; i--) {
      if (items[i].kind === 'tool') {
        lastTool = i
        break
      }
    }

    const answerAt = items.findIndex((item, i) => i > Math.max(lastTool, start - 1) && item.kind === 'assistant' && item.text.trim())

    if (answerAt >= 0 && payload.response_transformed && finalText.trim()) {
      items = items.map((item, i) => (i === answerAt ? { ...item, text: finalText } as Item : item))
    } else if (answerAt < 0 && finalText.trim() && !payload.response_previewed) {
      items = [...items, { kind: 'assistant', id: localId('a'), text: finalText }]
    }

    if (typeof payload.reasoning === 'string' && payload.reasoning.trim() && !items.slice(start).some(i => i.kind === 'assistant' && i.reasoning?.trim())) {
      items = withReasoning(items, payload.reasoning)
    }

    if (payload.status === 'error') {
      const text = String(payload.error || payload.failure_reason || 'The turn failed.')
      items = [...items, { kind: 'notice', id: localId('n'), text, tone: 'error' }]
    } else if (payload.status === 'interrupted') {
      items = [...items, { kind: 'notice', id: localId('n'), text: 'Stopped', tone: 'info' }]
    }

    if (typeof payload.warning === 'string' && payload.warning.trim()) {
      items = [...items, { kind: 'notice', id: localId('n'), text: payload.warning, tone: 'warn' }]
    }

    return {
      items,
      running: false,
      status: null,
      usage: (payload.usage as Chat['usage']) ?? c.usage
    }
  })
}

// Hermes decorates its thinking line with a kaomoji spinner, e.g. "(⊙_⊙) cogitating...".
// Hermes's spinner words ("(｡•́︿•̀｡) ruminating...") say only that the model is thinking; the desktop
// app reads them the same way (apps/src/lib/chat-runtime.ts, THINKING_STATUS_PREFIX_RE).
const THINKING_WORD = /^(?:\S{1,16}\s+)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)(?:\.\.\.|…)?$/i

function cleanStatus(text: string) {
  const stripped = text.replace(/^\s*\([^)]{1,12}\)\s*/, '').trim()

  if (THINKING_WORD.test(stripped)) {
    return 'Thinking…'
  }

  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : ''
}

const TOOL_NAMES: Record<string, string> = {
  terminal: 'a command',
  execute_code: 'code',
  read_file: 'a file read',
  write_file: 'a file',
  patch: 'an edit',
  search_files: 'a search',
  web_search: 'a web search',
  web_extract: 'a page read',
  skill_view: 'a skill',
  delegate_task: 'a subagent',
  todo: 'the plan'
}

/** A readable name for a tool, never a raw identifier. */
export function friendlyTool(name: string) {
  const bare = name.replace(/^mcp__/, '').replace(/^[a-z0-9]+__/, '')

  return TOOL_NAMES[bare] || bare.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
