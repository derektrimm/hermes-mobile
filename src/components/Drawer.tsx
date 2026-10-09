import { useEffect, useMemo, useRef, useState } from 'react'

import { api, type SearchHit, type SessionRow } from '../lib/api'
import { busyKey, deleteChat, newChat, openSession, refreshLive, refreshSessions } from '../lib/hermes'
import { displayTitle, rowTime } from '../lib/format'
import { accountLabel } from '../lib/labels'
import { haptic } from '../lib/haptics'
import { SERVER } from '../lib/site'
import { confirmAction, setState, toast, useStore } from '../lib/store'
import { ComposeIcon, MoreIcon, PencilIcon, SearchIcon, TrashIcon } from './icons'
import { Sheet } from './Sheet'

const SOURCES: Record<string, string> = {
  cli: 'Terminal',
  tui: 'Terminal',
  desktop: 'Desktop',
  discord: 'Discord',
  api_server: 'Automation',
  oneshot: 'One-off',
  acp: 'Editor',
  dashboard: 'Web',
  web: 'Web',
  cron: 'Scheduled'
}

function dayBucket(ts: number): string {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
  const day = 86400

  if (ts >= start) {
    return 'Today'
  }

  if (ts >= start - day) {
    return 'Yesterday'
  }

  if (ts >= start - 6 * day) {
    return 'Previous 7 days'
  }

  if (ts >= start - 29 * day) {
    return 'Previous 30 days'
  }

  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fired = useRef(false)
  const origin = useRef<{ x: number; y: number } | null>(null)

  return {
    fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        fired.current = false
        origin.current = { x: e.clientX, y: e.clientY }
        timer.current = setTimeout(() => {
          fired.current = true
          haptic()
          onLong()
        }, 480)
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (origin.current && Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 8) {
          clearTimeout(timer.current)
        }
      },
      onPointerUp: () => clearTimeout(timer.current),
      onPointerCancel: () => clearTimeout(timer.current),
      onContextMenu: (e: React.MouseEvent) => e.preventDefault()
    }
  }
}

function Row({
  row,
  active,
  label,
  profileLabel,
  busy,
  fromPhone,
  onMenu
}: {
  row: SessionRow
  active: boolean
  label: string | null
  profileLabel: string | null
  busy: boolean
  fromPhone: boolean
  onMenu: (row: SessionRow) => void
}) {
  const press = useLongPress(() => onMenu(row))
  const source = fromPhone ? 'Phone' : row.source ? SOURCES[row.source] ?? row.source : null

  return (
    <div className={`row-wrap ${active ? 'active' : ''}`}>
      <button
        type="button"
        className="row"
        {...press.handlers}
        onClick={() => {
          if (!press.fired.current) {
            void openSession(row)
          }
        }}
      >
        <span className="row-title">
          {busy ? <span className="dot busy" aria-label="Working" /> : null}
          <span>{displayTitle(row.title || row.preview, 'Untitled chat')}</span>
        </span>
        <span className="row-time">{rowTime(row.last_activity_at || row.started_at)}</span>
        <span className="row-meta">
          {label ? <span className="tag">{label}</span> : null}
          {[profileLabel, source].filter(Boolean).join(' · ')}
        </span>
      </button>
      {active ? (
        <button type="button" className="icon-btn subtle" aria-label="Chat options" onClick={() => onMenu(row)}>
          <MoreIcon size={20} />
        </button>
      ) : null}
    </div>
  )
}

export function Drawer() {
  const open = useStore(s => s.drawer)
  const sessions = useStore(s => s.sessions)
  const loaded = useStore(s => s.sessionsLoaded)
  const profiles = useStore(s => s.profiles)
  const live = useStore(s => s.live)
  const runtimes = useStore(s => s.runtimes)
  const phoneChats = useStore(s => s.phoneChats)
  const busy = useStore(s => s.busy)
  const current = useStore(s => s.chat.storedId)
  const conn = useStore(s => s.conn)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [menu, setMenu] = useState<SessionRow | null>(null)
  const [renaming, setRenaming] = useState('')

  useEffect(() => {
    if (!open) {
      return
    }

    void refreshSessions()
    void refreshLive()
    const timer = setInterval(() => void refreshLive(), 8000)

    return () => clearInterval(timer)
  }, [open])

  // Titles filter instantly; message contents are searched on the backend after a pause.
  useEffect(() => {
    const q = query.trim()

    if (q.length < 2) {
      setHits(null)

      return
    }

    const timer = setTimeout(() => {
      const names = profiles.length ? profiles.map(p => p.name) : ['default']
      void Promise.allSettled(names.map(name => api.search(name, q))).then(results =>
        setHits(results.flatMap(r => (r.status === 'fulfilled' ? r.value : [])))
      )
    }, 320)

    return () => clearTimeout(timer)
  }, [query, profiles])

  const profileLabel = (name: string) =>
    profiles.length > 1 && name ? accountLabel(name, profiles.find(p => p.name === name)?.display_name) : null

  const liveLabel = (row: SessionRow) => {
    const holder = live.find(l => l.session_id === row.id && (l.profile === row.profile || l.profile === null))

    if (!holder || holder.holder === 'phone-backend') {
      return null
    }

    return holder.holder === 'pc-window' || holder.holder === 'pc-shared' ? 'On PC' : holder.holder === 'desktop-app' ? 'Desktop' : 'Open'
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    // A chat just opened in the desktop app has no stored messages yet, so the stored list misses it.
    const liveOnly: SessionRow[] = live
      .filter(l => (l.holder === 'desktop-app' || l.holder === 'pc-shared') && !sessions.some(s => s.id === l.session_id))
      .filter((l, i, all) => all.findIndex(o => o.session_id === l.session_id) === i)
      .map(l => ({ id: l.session_id, title: l.title, profile: l.profile ?? '', source: l.holder === 'pc-shared' ? 'tui' : 'desktop', last_activity_at: l.started_at }))
    const all = [...liveOnly, ...sessions]
    const titleMatches = q ? all.filter(s => (s.title || s.preview || '').toLowerCase().includes(q)) : all
    const seen = new Set(titleMatches.map(s => `${s.profile}:${s.id}`))
    const contentMatches: SessionRow[] = (hits || [])
      .filter(h => !seen.has(`${h.profile}:${h.id}`) && (seen.add(`${h.profile}:${h.id}`), true))
      .map(h => ({ id: h.id, title: h.title, preview: h.snippet, last_activity_at: h.last_active, source: h.source, profile: h.profile }))
    const rows = [...titleMatches, ...contentMatches]
    const out: Array<{ label: string; rows: SessionRow[] }> = []

    for (const row of rows) {
      const label = q ? 'Results' : dayBucket(row.last_activity_at || row.started_at || 0)
      const group = out[out.length - 1]

      if (group?.label === label) {
        group.rows.push(row)
      } else {
        out.push({ label, rows: [row] })
      }
    }

    return out
  }, [sessions, live, hits, query])

  return (
    <>
      <div className={`scrim ${open ? 'show' : ''}`} onClick={() => setState({ drawer: false })} />
      <aside className={`drawer ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
        <div className="drawer-top">
          <label className="search">
            <SearchIcon size={17} />
            <input
              type="search"
              placeholder="Search chats"
              value={query}
              onChange={event => setQuery(event.target.value)}
              enterKeyHint="search"
            />
          </label>
          <button type="button" className="icon-btn" aria-label="New chat" onClick={() => newChat()}>
            <ComposeIcon size={21} />
          </button>
        </div>
        <div className="drawer-list">
          {!loaded ? <div className="drawer-empty">Loading chats…</div> : null}
          {loaded && !groups.length ? (
            <div className="drawer-empty">{query ? 'No chats match.' : 'No chats yet.'}</div>
          ) : null}
          {groups.map(group => (
            <section key={group.label}>
              <h3>{group.label}</h3>
              {group.rows.map(row => (
                <Row
                  key={`${row.profile}:${row.id}`}
                  row={row}
                  active={row.id === current}
                  label={liveLabel(row)}
                  profileLabel={profileLabel(row.profile)}
                  busy={Boolean(runtimes[row.id] && busy[busyKey(runtimes[row.id].backend ?? 'main', runtimes[row.id].liveId)])}
                  fromPhone={row.source === 'tui' && (phoneChats.includes(row.id) || ((runtimes[row.id]?.backend ?? 'main') === 'main' && Boolean(runtimes[row.id])))}
                  onMenu={r => {
                    setMenu(r)
                    setRenaming(r.title || '')
                  }}
                />
              ))}
            </section>
          ))}
        </div>
        <div className="drawer-foot">
          <span className={`dot ${conn === 'open' ? 'ok' : 'busy'}`} />
          {conn === 'open' ? `Connected to ${SERVER}` : 'Reconnecting…'}
        </div>
      </aside>
      <Sheet open={Boolean(menu)} onClose={() => setMenu(null)} title={menu?.title || 'Chat'}>
        {menu ? (
          <div className="sheet-actions">
            <form
              className="rename"
              onSubmit={event => {
                event.preventDefault()

                if (renaming.trim()) {
                  void api
                    .rename(menu.profile, menu.id, renaming.trim())
                    .then(() => refreshSessions())
                    .catch(error => toast(`Could not rename: ${error instanceof Error ? error.message : String(error)}`, 'error'))
                    .finally(() => setMenu(null))
                }
              }}
            >
              <input className="field" value={renaming} onChange={event => setRenaming(event.target.value)} />
              <button type="submit" className="btn">
                <PencilIcon size={16} /> Rename
              </button>
            </form>
            <button
              type="button"
              className="btn danger wide"
              onClick={() => {
                const row = menu
                setMenu(null)
                void confirmAction({
                  title: 'Delete this chat?',
                  body: 'The conversation is removed from every device. This cannot be undone.',
                  confirm: 'Delete chat',
                  cancel: 'Keep it',
                  danger: true
                }).then(ok => {
                  if (ok) {
                    void deleteChat(row)
                  }
                })
              }}
            >
              <TrashIcon size={16} /> Delete chat
            </button>
          </div>
        ) : null}
      </Sheet>
    </>
  )
}
