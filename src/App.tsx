import { useEffect } from 'react'

import { Asks } from './components/Asks'
import { Composer } from './components/Composer'
import { Drawer } from './components/Drawer'
import { Header } from './components/Header'
import { ChevronIcon } from './components/icons'
import { Sheet } from './components/Sheet'
import { Thread } from './components/Thread'
import { openByLiveId, send } from './lib/hermes'
import { SERVER, SERVER_CAP } from './lib/site'
import { setState, useStore } from './lib/store'

// iOS does not shrink the layout viewport for the keyboard in a home-screen app, so the app sizes
// itself to the visual viewport: the composer stays on top of the keyboard, never under it.
function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport
    const root = document.documentElement

    const update = () => {
      const height = vv ? vv.height : window.innerHeight
      root.style.setProperty('--app-height', `${Math.round(height)}px`)
      root.style.setProperty('--app-top', `${Math.round(vv?.offsetTop ?? 0)}px`)
      root.classList.toggle('keyboard', vv ? window.innerHeight - vv.height > 120 : false)
    }

    update()
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)

    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
}

const SUGGESTIONS = [`How is ${SERVER} doing right now?`, 'What did my sessions get done today?', 'Is anything stuck in the CI queue?']

/** The first screen reports the state of your machines, then offers a start. */
function Empty() {
  const conn = useStore(s => s.conn)
  const live = useStore(s => s.live)
  const asks = useStore(s => s.asks)
  const onPc = new Set(live.filter(l => l.holder === 'pc-window').map(l => l.session_id)).size
  const inApp = new Set(live.filter(l => l.holder === 'desktop-app').map(l => l.session_id)).size
  const waiting = new Set(asks.map(a => `${a.backend}:${a.liveId}`)).size

  const heading = conn === 'open' ? `Hermes is on ${SERVER}` : conn === 'connecting' ? `Connecting to ${SERVER}` : `${SERVER_CAP} is unreachable`
  const places = [
    onPc ? `${onPc} chat${onPc === 1 ? '' : 's'} live on your PC` : '',
    inApp ? `${inApp} in the desktop app` : ''
  ].filter(Boolean)

  return (
    <div className="empty">
      <img src="/icons/icon-180.png" alt="" className="empty-logo" />
      <h1>{heading}</h1>
      {waiting ? (
        <button type="button" className="empty-sub" onClick={() => asks[0] && void openByLiveId(asks[0].liveId)}>
          {waiting === 1 ? '1 chat is waiting for your answer' : `${waiting} chats are waiting for your answer`}
        </button>
      ) : conn === 'open' ? (
        <p className="empty-sub">{places.length ? `${places.join(' · ')} · nothing waiting on you` : 'No chats open elsewhere'}</p>
      ) : null}
      {conn === 'open' ? (
        <div className="suggestions">
          {SUGGESTIONS.map(text => (
            <button key={text} type="button" className="suggestion" onClick={() => void send(text)}>
              <span>{text}</span>
              <ChevronIcon size={16} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A chat open somewhere the phone cannot join (a Discord thread, another tool): shown read-only. */
function WatchBar() {
  const watch = useStore(s => s.chat.watch)

  if (!watch) {
    return null
  }

  return (
    <div className="watchbar">
      <div className="watch-text">
        <strong>Open in {watch.holder_label}</strong>
        <span>Live. Reply there; it updates here as it goes.</span>
      </div>
    </div>
  )
}

function ConfirmView() {
  const request = useStore(s => s.confirmRequest)

  return (
    <Sheet open={Boolean(request)} onClose={() => request?.resolve(false)} title={request?.title} top>
      {request ? (
        <>
          <p className="sheet-text">{request.body}</p>
          <div className="confirm-actions">
            <button type="button" className={`btn wide ${request.danger ? 'danger' : 'primary'}`} onClick={() => request.resolve(true)}>
              {request.confirm}
            </button>
            <button type="button" className="btn ghost wide" onClick={() => request.resolve(false)}>
              {request.cancel}
            </button>
          </div>
        </>
      ) : null}
    </Sheet>
  )
}

function ToastView() {
  const toast = useStore(s => s.toast)

  if (!toast) {
    return null
  }

  return (
    <div className={`toast ${toast.tone}`} role="status">
      <span>{toast.text}</span>
      {toast.action ? (
        <button
          type="button"
          onClick={() => {
            toast.action?.run()
            setState({ toast: null })
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  )
}

export function App() {
  useVisualViewport()
  const chat = useStore(s => s.chat)
  const asks = useStore(s => s.asks)
  const empty = !chat.items.length && !chat.loading && !chat.storedId

  return (
    <div className="app">
      <Header />
      <main className="main">
        {chat.loading && !chat.items.length ? (
          <div className="loading">
            <span className="spinner" />
          </div>
        ) : empty ? (
          <Empty />
        ) : (
          <Thread chat={chat} />
        )}
        {chat.error ? <div className="notice error floating">{chat.error}</div> : null}
      </main>
      <div className="bottom">
        <ToastView />
        <Asks asks={asks} liveId={chat.liveId} backend={chat.backend} />
        {chat.watch && chat.watch.holder !== 'pc-window' ? <WatchBar /> : <Composer chat={chat} />}
      </div>
      <Drawer />
      <ConfirmView />
    </div>
  )
}
