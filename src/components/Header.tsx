import { useEffect, useRef, useState } from 'react'

import { displayTitle, placeOf } from '../lib/format'
import { accountLabel, EFFORTS, effortHint, effortLabel, modelLabel, providerLabel } from '../lib/labels'
import { haptic } from '../lib/haptics'
import { SERVER, SERVER_CAP } from '../lib/site'
import { defaultEffort, deleteChat, modelOptions, newChat, pendingEffortChoice, pendingModelChoice, releaseToPc, renameChat, setEffort, switchModel } from '../lib/hermes'
import { confirmAction, setState, useStore } from '../lib/store'
import { CheckIcon, ChevronDownIcon, ChevronIcon, ComposeIcon, MenuIcon, SearchIcon } from './icons'
import { Sheet } from './Sheet'
import type { ModelOptionsResult } from '../../vendor/hermes-shared/gateway-contract.generated'

function Models({ onDone }: { onDone: () => void }) {
  const [options, setOptions] = useState<ModelOptionsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const current = useStore(s => s.chat.info?.model) || pendingModelChoice()?.model
  const profileName = useStore(s => s.chat.profile || s.profile)
  const account = useStore(s => {
    const profile = s.profiles.find(p => p.name === (s.chat.profile || s.profile))

    return profile ? accountLabel(profile.name, profile.display_name) : ''
  })

  useEffect(() => {
    modelOptions()
      .then(setOptions)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) {
    return <p className="sheet-text muted">Models are unavailable right now: {error}</p>
  }

  if (!options) {
    return <p className="sheet-text muted">Loading models…</p>
  }

  const isCurrent = (p: ModelOptionsResult['providers'][number]) => Boolean(p.is_current || p.slug === options.provider)
  const providers = options.providers
    .filter(p => p.authenticated !== false && (p.models?.length ?? 0) > 0)
    .sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)))
  const currentProvider = providers.find(isCurrent)
  const needle = query.trim().toLowerCase()

  // An account can be set up to run on another account's subscription; say so rather than leave
  // "Claude 1" above a "Claude 2 Subscription" check mark unexplained.
  const runsOn = currentProvider ? providerLabel(currentProvider.slug, currentProvider.name) : ''
  const borrowed = /^Claude \d+ Subscription$/.test(runsOn) && account && !runsOn.startsWith(`${account} `)

  if (!providers.length) {
    return (
      <p className="sheet-text muted">
        No models are available to {account || 'this account'} yet. Sign it in to a provider on {SERVER} (hermes -p {profileName} auth),
        then open this again.
      </p>
    )
  }

  return (
    <div className="models">
      <label className="search sheet-search">
        <SearchIcon size={17} />
        <input
          type="search"
          placeholder="Search models"
          value={query}
          onChange={event => setQuery(event.target.value)}
          enterKeyHint="search"
        />
      </label>
      {borrowed ? (
        <p className="sheet-note">
          {account} is set up to use the {runsOn.replace(/ Subscription$/, '')} subscription.
        </p>
      ) : null}
      {providers.map(provider => {
        const all = provider.models || []
        const shown = needle
          ? all.filter(model => model.toLowerCase().includes(needle) || modelLabel(model).toLowerCase().includes(needle))
          : provider.featured_models?.length
            ? provider.featured_models
            : all
        const open = Boolean(needle) || isCurrent(provider) || opened.has(provider.slug)

        if (needle && !shown.length) {
          return null
        }

        return (
          <section key={provider.slug} className="sheet-section">
            <button
              type="button"
              className="group-head"
              aria-expanded={open}
              disabled={Boolean(needle) || isCurrent(provider)}
              onClick={() =>
                setOpened(set => {
                  const next = new Set(set)
                  next.has(provider.slug) ? next.delete(provider.slug) : next.add(provider.slug)

                  return next
                })
              }
            >
              <h4>{providerLabel(provider.slug, provider.name)}</h4>
              {needle || isCurrent(provider) ? null : <ChevronDownIcon size={16} className={open ? 'flip' : ''} />}
            </button>
            {open ? (
              <div className="settings">
                {shown.map((model, _, list) => {
                  const active = model === (current || options.model) && isCurrent(provider)
                  // Two ids that read the same ("grok-4.7", "grok-4-7") show their ids to tell apart.
                  const twin = list.some(other => other !== model && modelLabel(other) === modelLabel(model))

                  return (
                    <button
                      key={model}
                      type="button"
                      className="setting"
                      aria-pressed={active}
                      onClick={() => {
                        haptic()
                        void switchModel(provider.slug, model).then(ok => ok && onDone())
                      }}
                    >
                      {twin ? (
                        <span className="setting-main">
                          <span>{modelLabel(model)}</span>
                          <span className="setting-hint">{model}</span>
                        </span>
                      ) : (
                        <span>{modelLabel(model)}</span>
                      )}
                      {active ? <CheckIcon size={18} className="setting-check" /> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </section>
        )
      })}
      {needle && !providers.some(p => (p.models || []).some(m => m.toLowerCase().includes(needle) || modelLabel(m).toLowerCase().includes(needle))) ? (
        <p className="sheet-text muted">No models match.</p>
      ) : null}
    </div>
  )
}

/** The chat's effort: live, else picked for the first message, else the account's default. */
function useEffort() {
  const live = useStore(s => s.chat.info?.reasoning_effort)
  const profile = useStore(s => s.chat.profile)
  const liveId = useStore(s => s.chat.liveId)
  const backend = useStore(s => s.chat.backend)
  const conn = useStore(s => s.conn)
  const pending = pendingEffortChoice()
  const [fallback, setFallback] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setFallback(null)

    if (!live && conn === 'open') {
      void defaultEffort(profile, liveId, backend).then(value => current && setFallback(value))
    }

    return () => {
      current = false
    }
  }, [live, profile, liveId, backend, conn])

  return live || pending || fallback || ''
}

/** The model's own reasoning settings, from the provider catalog (reasoning at all, can it be off). */
function useModelCaps() {
  const [caps, setCaps] = useState<{ reasoning: boolean; canDisable: boolean } | null>(null)
  const model = useStore(s => s.chat.info?.model) || pendingModelChoice()?.model

  useEffect(() => {
    modelOptions()
      .then(options => {
        const current = model || options.model
        const provider = options.providers.find(p => p.slug === (pendingModelChoice()?.provider || options.provider)) ?? options.providers.find(p => p.models?.includes(current ?? ''))
        const entry = provider?.capabilities?.[current ?? '']
        setCaps({ reasoning: entry ? entry.reasoning !== false : true, canDisable: entry?.can_disable_reasoning === true })
      })
      .catch(() => setCaps({ reasoning: true, canDisable: false }))
  }, [model])

  return caps
}

function Efforts({ onDone }: { onDone: () => void }) {
  const info = useStore(s => s.chat.info)
  const caps = useModelCaps()
  const current = useEffort()
  const wire = info?.reasoning_effort_wire
  const model = modelLabel(info?.model || pendingModelChoice()?.model) || 'This model'

  if (!caps) {
    return <p className="sheet-text muted">Loading…</p>
  }

  if (!caps.reasoning) {
    return <p className="sheet-text muted">{model} answers without an effort setting.</p>
  }

  const levels = [...(caps.canDisable ? ['none'] : []), ...EFFORTS]

  return (
    <div className="models">
      <div className="settings">
        {levels.map(level => {
          const on = level === current

          return (
            <button
              key={level}
              type="button"
              className="setting"
              aria-pressed={on}
              onClick={() => {
                haptic()
                void setEffort(level).then(ok => ok && onDone())
              }}
            >
              <span className="setting-main">
                <span>{effortLabel(level)}</span>
                <span className="setting-hint">{effortHint(level)}</span>
              </span>
              {on ? <CheckIcon size={18} className="setting-check" /> : null}
            </button>
          )
        })}
      </div>
      {wire && current && wire !== current ? (
        <p className="sheet-note">
          {model} tops out below {effortLabel(current)}, so it receives {effortLabel(wire)}.
        </p>
      ) : null}
    </div>
  )
}

/** Connection strip: shown while the server is unreachable, then "Connected" for a moment. */
function ConnBanner() {
  const conn = useStore(s => s.conn)
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [flash, setFlash] = useState(false)
  const was = useRef(conn)

  useEffect(() => {
    const previous = was.current
    was.current = conn

    if (conn === 'open') {
      setSince(null)

      if (previous === 'reconnecting') {
        setFlash(true)
        const timer = setTimeout(() => setFlash(false), 1200)

        return () => clearTimeout(timer)
      }
    } else {
      setSince(current => current ?? Date.now())
    }
  }, [conn])

  useEffect(() => {
    if (conn === 'open') {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [conn])

  if (conn === 'open') {
    return flash ? (
      <div className="conn-banner">
        <span className="dot ok" />
        Connected
      </div>
    ) : null
  }

  const long = since !== null && now - since > 15_000

  return (
    <div className="conn-banner" role="status">
      <span className={`dot ${long ? 'bad' : 'busy'}`} />
      {conn === 'connecting' ? `Connecting to ${SERVER}` : long ? `${SERVER_CAP} is unreachable. Still trying.` : `Reconnecting to ${SERVER}`}
    </div>
  )
}

export function Header() {
  const chat = useStore(s => s.chat)
  const profiles = useStore(s => s.profiles)
  const profile = useStore(s => s.profile)
  const [sheet, setSheet] = useState<null | 'chat' | 'models' | 'effort'>(null)
  const [title, setTitle] = useState('')
  const fresh = !chat.storedId
  const place = placeOf(chat)
  const account = profiles.find(p => p.name === chat.profile)
  const profileName = chat.profile ? accountLabel(chat.profile, account?.display_name) : ''
  const model = modelLabel(chat.info?.model || pendingModelChoice()?.model || account?.model)
  const effort = effortLabel(useEffort())

  useEffect(() => setTitle(displayTitle(chat.title, '')), [chat.title, sheet])

  const closeSheet = () => {
    // The name commits when the sheet closes: one field, no separate Rename button.
    if (sheet === 'chat' && !fresh && title.trim() && title.trim() !== displayTitle(chat.title, '')) {
      void renameChat(title)
    }

    setSheet(null)
  }

  const usage = chat.usage
  const percent = typeof usage?.context_percent === 'number' ? usage.context_percent : null
  const cost = typeof usage?.cost_usd === 'number' ? `$${usage.cost_usd.toFixed(2)} so far` : null
  const subParts = [profileName, model, effort].filter(Boolean)

  return (
    <>
      <header className="header">
        <button type="button" className="icon-btn" aria-label="Chats" onClick={() => setState({ drawer: true })}>
          <MenuIcon />
        </button>
        <button type="button" className="title-btn" onClick={() => setSheet('chat')}>
          <span className="title-main">{fresh ? 'New chat' : displayTitle(chat.title, 'Chat')}</span>
          <span className="place">
            {place ? (
              <>
                <span className={`dot ${place.busy ? 'busy' : ''}`} />
                <span className="place-name">{place.word}</span>
                {subParts.length ? <span className="place-sep">·</span> : null}
              </>
            ) : null}
            {subParts.map((part, i) => (
              <span key={part}>
                {i ? <span className="place-sep">· </span> : null}
                {part}
              </span>
            ))}
            <ChevronDownIcon size={13} />
          </span>
        </button>
        <button type="button" className="icon-btn" aria-label="New chat" onClick={() => newChat(chat.profile || profile)}>
          <ComposeIcon />
        </button>
      </header>
      <ConnBanner />

      <Sheet open={sheet === 'chat'} onClose={closeSheet} title={fresh ? 'New chat' : displayTitle(chat.title, 'Chat')}>
        {fresh ? (
          <section className="sheet-section">
            <h4>Account</h4>
            <div className="settings">
              {profiles.map(p => {
                const on = p.name === (chat.profile || profile)

                return (
                  <button
                    key={p.name}
                    type="button"
                    className="setting"
                    aria-pressed={on}
                    onClick={() => {
                      haptic()
                      newChat(p.name)
                      setSheet(null)
                    }}
                  >
                    <span>{accountLabel(p.name, p.display_name)}</span>
                    <span className="setting-value">
                      {modelLabel(p.model)}
                      {on ? <CheckIcon size={18} className="setting-check" /> : <span className="setting-check-space" />}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}

        {place ? (
          <section className="sheet-section">
            <h4>Where</h4>
            <p className="sheet-text">{place.sentence}</p>
          </section>
        ) : !fresh && chat.liveId && !chat.running ? (
          <section className="sheet-section">
            <h4>Where</h4>
            <div className="settings">
              <button
                type="button"
                className="setting"
                onClick={() => {
                  setSheet(null)
                  void releaseToPc()
                }}
              >
                <span className="setting-main">
                  <span>Continue on PC</span>
                  <span className="setting-hint">Frees this chat so a Hermes window on your PC can open it</span>
                </span>
                <ChevronIcon size={16} className="setting-chevron" />
              </button>
            </div>
          </section>
        ) : null}

        <section className="sheet-section">
          <h4>Settings</h4>
          {chat.watch ? (
            <p className="sheet-text muted">Available once the phone has joined this chat.</p>
          ) : (
            <>
              <div className="settings">
                <button type="button" className="setting" onClick={() => setSheet('models')}>
                  <span>Model</span>
                  <span className="setting-value">
                    {model || 'Default'}
                    <ChevronIcon size={16} />
                  </span>
                </button>
                <button type="button" className="setting" onClick={() => setSheet('effort')}>
                  <span>Effort</span>
                  <span className="setting-value">
                    {effort || 'Default'}
                    <ChevronIcon size={16} />
                  </span>
                </button>
              </div>
            </>
          )}
        </section>

        {!fresh ? (
          <>
            <section className="sheet-section">
              <h4>Name</h4>
              <input
                className="field"
                value={title}
                enterKeyHint="done"
                placeholder="Chat name"
                onChange={event => setTitle(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                    closeSheet()
                  }
                }}
              />
            </section>

            {percent !== null || cost ? (
              <section className="sheet-section">
                <h4>Usage</h4>
                <div className="usage">
                  <div>
                    Context {percent ?? 0}%
                    <div className="meter">
                      <span style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
                    </div>
                  </div>
                  <div>{cost ?? ''}</div>
                </div>
                {chat.info?.cwd ? <p className="cwd">Works in {chat.info.cwd.replace(/^\/home\/[^/]+/, '~')}</p> : null}
              </section>
            ) : null}

            {place ? null : <section className="sheet-section">
              <button
                type="button"
                className="btn danger wide"
                onClick={() => {
                  setSheet(null)
                  void confirmAction({
                    title: 'Delete this chat?',
                    body: 'The conversation is removed from every device. This cannot be undone.',
                    confirm: 'Delete chat',
                    cancel: 'Keep it',
                    danger: true
                  }).then(ok => {
                    if (ok && chat.storedId) {
                      void deleteChat({ id: chat.storedId, profile: chat.profile })
                    }
                  })
                }}
              >
                Delete chat
              </button>
            </section>}
          </>
        ) : null}
      </Sheet>

      <Sheet open={sheet === 'models'} onClose={() => setSheet(null)} title="Model">
        <Models onDone={() => setSheet(null)} />
      </Sheet>

      <Sheet open={sheet === 'effort'} onClose={() => setSheet(null)} title="Effort">
        <Efforts onDone={() => setSheet(null)} />
      </Sheet>
    </>
  )
}
