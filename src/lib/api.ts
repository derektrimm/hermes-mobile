// REST calls the app's server proxies to the Hermes backend (token added server-side), plus the
// server's own /hm endpoints for live-session ownership and PC hand-off.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null
  ) {
    super(message)
  }
}

// Every request has a deadline, so a stuck backend shows as an error instead of a spinner forever.
// Joining a PC window waits for that window to let go and come back, so it gets longer.
async function call<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers }
  })
  const text = await response.text()
  let body: unknown = null

  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (!response.ok) {
    const detail =
      (body && typeof body === 'object' && ('error' in body || 'detail' in body)
        ? String((body as Record<string, unknown>).error ?? (body as Record<string, unknown>).detail)
        : null) || `HTTP ${response.status}`

    throw new HttpError(response.status, detail, body)
  }

  return body as T
}

export interface Profile {
  name: string
  display_name?: string | null
  model?: string | null
  provider?: string | null
  is_default?: boolean
}

export interface SessionRow {
  id: string
  title?: string | null
  preview?: string | null
  started_at?: number | null
  last_activity_at?: number | null
  message_count?: number | null
  source?: string | null
  model?: string | null
  /** The directory the chat works in (a phone chat: the account's Hermes folder on the server). */
  cwd?: string | null
  profile: string
}

export interface SearchHit {
  id: string
  title?: string | null
  snippet?: string | null
  last_active?: number | null
  source?: string | null
  profile: string
}

export interface LiveSession {
  session_id: string
  /** Null for a desktop-app chat that has no stored messages yet. */
  profile: string | null
  pid: number
  surface: string | null
  started_at: number | null
  holder: 'pc-window' | 'pc-shared' | 'desktop-app' | 'phone-backend' | 'other'
  holder_label: string
  /** The backend the phone can join to drive this chat: 'main', 'desktop-<pid>', or null. */
  backend: string | null
  /** Desktop-app chats only: the live title and status (the stored list misses brand-new chats). */
  title?: string | null
  status?: string | null
  /** Driven on a PC-window backend with no window open on it (commands still run on the PC). */
  windowless?: boolean
}

/** A PC-window backend set up on the server for one account (see server handsInstances). */
export interface HandsInstance {
  instance: string
  profile: string
  /** Its key while it runs ('pc-<pid>'), else null. */
  backend: string | null
  /** Whether its PC answers right now. */
  reachable: boolean
}

/** A raw stored message row (GET /api/sessions/{id}/messages). */
export interface StoredMessage {
  id: number
  role: string
  content: unknown
  tool_call_id?: string | null
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> | null
  tool_name?: string | null
  timestamp?: number | null
  reasoning?: string | null
  /** "hidden" for model-only scaffolding; other kinds are system notes (web_routers/sessions.py). */
  display_kind?: string | null
  /** What to show instead of the stored content (a steer's own words, a compaction summary). */
  display_content?: unknown
}

export const api = {
  profiles: () => call<{ profiles: Profile[] }>('/api/profiles').then(r => r.profiles),

  sessions: (profile: string, limit = 100) =>
    call<{ sessions: Array<Omit<SessionRow, 'profile'>> }>(
      `/api/sessions?profile=${encodeURIComponent(profile)}&limit=${limit}&order=recent`
    ).then(r => r.sessions.map(s => ({ ...s, profile }))),

  search: (profile: string, q: string) =>
    call<{ results: Array<Omit<SearchHit, 'profile'>> }>(
      `/api/sessions/search?profile=${encodeURIComponent(profile)}&q=${encodeURIComponent(q)}&limit=30`
    ).then(r => r.results.map(hit => ({ ...hit, profile }))),

  messages: (profile: string, sessionId: string) =>
    call<{ messages: StoredMessage[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}&inline_images=false`
    ).then(r => r.messages),

  rename: (profile: string, sessionId: string, title: string) =>
    call(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, profile })
    }),

  remove: (profile: string, sessionId: string) =>
    call(`/api/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(profile)}`, { method: 'DELETE' }),

  live: () => call<{ sessions: LiveSession[]; backends: string[]; phone_chats?: string[]; hands?: HandsInstance[] }>('/hm/live'),

  startHands: (instance: string) =>
    call<{ ok: boolean; backend?: string }>('/hm/hands-start', { method: 'POST', body: JSON.stringify({ instance }) }, 45_000),

  /** Type a message into the shared PC window showing this chat (see server typeIntoWindow). */
  typeInWindow: (sessionId: string, text: string, running: boolean) =>
    call<{ ok: boolean; typed: boolean; queued?: boolean; stuck?: boolean; reason?: string }>('/hm/type', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, text, running })
    }),

  phoneChat: (sessionId: string) =>
    call<{ ok: boolean }>('/hm/phone-chat', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId })
    }),

  share: (sessionId: string, profile: string) =>
    call<{ ok: boolean; backend?: string; error?: string }>(
      '/hm/share',
      { method: 'POST', body: JSON.stringify({ session_id: sessionId, profile }) },
      150_000
    )
}
