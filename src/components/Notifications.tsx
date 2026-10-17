import { useEffect, useState } from 'react'

import { disablePush, enablePush, PUSH_KINDS, type PushKind, type PushState, pushState, pushSupport, setPushPref, testPush } from '../lib/push'
import { toast } from '../lib/store'
import { Sheet } from './Sheet'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A native switch: iOS 17.4+ draws its own (with the system haptic); other browsers a checkbox. */
function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <input
      type="checkbox"
      className="switch"
      {...{ switch: '' }}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={event => onChange(event.target.checked)}
    />
  )
}

/** Notifications on this device: on or off, which kinds, and a test. */
export function NotificationsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const support = pushSupport()
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || support !== 'ok') {
      return
    }

    setError(null)
    pushState()
      .then(setState)
      .catch(e => setError(`Could not read the notification settings: ${errorText(e)}`))
  }, [open, support])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)

    try {
      await work()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleAll = (on: boolean) =>
    run(async () => {
      if (on) {
        setState(await enablePush(state?.prefs))
      } else {
        await disablePush()
        setState(s => (s ? { ...s, subscribed: false } : s))
      }
    })

  const toggleKind = (kind: PushKind, on: boolean) =>
    run(async () => {
      const prefs = await setPushPref(kind, on)
      setState(s => (s ? { ...s, prefs } : s))
    })

  return (
    <Sheet open={open} onClose={onClose} title="Notifications">
      {support === 'install' ? (
        <p className="sheet-text">
          Notifications reach Hermes only when it is opened from your Home Screen. In Safari, tap Share, then Add to Home Screen, and open
          Hermes from there.
        </p>
      ) : support === 'unsupported' ? (
        <p className="sheet-text">This browser cannot show notifications from Hermes.</p>
      ) : !state ? (
        error ? (
          <p className="sheet-text">{error}</p>
        ) : (
          <div className="sheet-loading">
            <span className="spinner" />
          </div>
        )
      ) : (
        <>
          <section className="sheet-section">
            <div className="settings">
              <label className="setting">
                <span className="setting-main">
                  <span>Notifications</span>
                  <span className="setting-hint">{state.subscribed ? 'On for this device' : 'When this app is closed'}</span>
                </span>
                <Switch
                  checked={state.subscribed}
                  disabled={busy || state.permission === 'denied'}
                  label="Notifications"
                  onChange={on => void toggleAll(on)}
                />
              </label>
            </div>
            {state.permission === 'denied' ? (
              <p className="sheet-note">
                Notifications for Hermes are turned off for this device. On an iPhone: Settings, Notifications, Hermes, then Allow
                Notifications.
              </p>
            ) : null}
          </section>
          {state.subscribed ? (
            <>
              <section className="sheet-section">
                <h4>Notify me when</h4>
                <div className="settings">
                  {PUSH_KINDS.map(({ kind, label, hint }) => (
                    <label key={kind} className="setting">
                      <span className="setting-main">
                        <span>{label}</span>
                        <span className="setting-hint">{hint}</span>
                      </span>
                      <Switch checked={state.prefs[kind]} disabled={busy} label={label} onChange={on => void toggleKind(kind, on)} />
                    </label>
                  ))}
                </div>
                <p className="sheet-note">
                  A chat on screen here stays quiet, and so does a quick reply to a message typed on your PC. Tapping a notification opens
                  its chat.
                </p>
              </section>
              <section className="sheet-section">
                <button
                  type="button"
                  className="btn ghost wide"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await testPush()
                      toast('Test sent. It arrives in a few seconds.')
                    })
                  }
                >
                  Send a test notification
                </button>
              </section>
            </>
          ) : null}
          {error ? <p className="sheet-note error-text">{error}</p> : null}
        </>
      )}
    </Sheet>
  )
}
