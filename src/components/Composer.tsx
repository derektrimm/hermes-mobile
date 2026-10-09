import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { type Attachment, commandCatalog, send, stop } from '../lib/hermes'
import { drafts, saveDraft } from '../lib/drafts'
import { haptic } from '../lib/haptics'
import { SERVER } from '../lib/site'
import { type Chat, setState, useStore } from '../lib/store'
import { CloseIcon, MonitorIcon, PlusIcon, SendIcon, StopIcon } from './icons'

// Terminal-UI commands the gateway cannot run for a phone (tui_gateway/AGENTS.md, slash command flow).
const LOCAL_ONLY = new Set(['/quit', '/exit', '/resume', '/copy', '/paste', '/model'])
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/** Phone photos are 12+ MP; the agent needs far less, and the upload rides the phone's network. */
async function shrink(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  return { name: file.name.replace(/\.\w+$/, '') + '.jpg', dataUrl: canvas.toDataURL('image/jpeg', 0.85) }
}

export function Composer({ chat }: { chat: Chat }) {
  const key = chat.storedId ?? `new:${chat.profile}`
  const [text, setText] = useState(() => drafts.get(key) ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [commands, setCommands] = useState<Array<{ name: string; description: string }> | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setText(drafts.get(key) ?? '')
    setAttachments([])
    setCommands(null) // another chat can be another account, with other skills
  }, [key])

  useEffect(() => {
    if ((drafts.get(key) ?? '') !== text) {
      saveDraft(key, text)
    }
  }, [key, text])

  const prefill = useStore(s => s.prefill)

  useEffect(() => {
    if (prefill) {
      setText(prefill)
      setState({ prefill: null })
      input.current?.focus()
    }
  }, [prefill])

  // Grow with the text up to a third of the screen, then scroll inside.
  useLayoutEffect(() => {
    const el = input.current

    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.33))}px`
    }
  }, [text])

  const slashQuery = /^\/[^\s]*$/.test(text) ? text.toLowerCase() : null

  useEffect(() => {
    if (slashQuery !== null && !commands) {
      commandCatalog()
        .then(setCommands)
        .catch(() => setCommands([]))
    }
  }, [slashQuery, commands])

  const matches = useMemo(
    () =>
      slashQuery !== null && commands
        ? commands.filter(c => c.name.toLowerCase().startsWith(slashQuery) && !LOCAL_ONLY.has(c.name)).slice(0, 8)
        : [],
    [slashQuery, commands]
  )

  const online = useStore(s => s.conn) === 'open'
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !busy && !chat.loading && online
  const remote = Boolean(chat.shared) || chat.watch?.holder === 'pc-window'
  const placeholder = !online
    ? `Waiting for ${SERVER}`
    : chat.running
      ? 'Add a follow-up'
      : remote
        ? chat.shared?.holder === 'pc-shared' || chat.watch?.holder === 'pc-window'
          ? 'Message Hermes on your PC'
          : 'Message Hermes in the desktop app'
        : 'Message Hermes'

  const submit = async () => {
    if (!canSend) {
      return
    }

    const body = text
    const files = attachments
    haptic()
    setBusy(true)
    setText('')
    setAttachments([])

    const ok = await send(body, files)
    setBusy(false)

    if (!ok) {
      setText(body)
      setAttachments(files)
    }
  }

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) {
      return
    }

    const added = await Promise.all([...files].filter(f => f.type.startsWith('image/')).map(shrink))
    setAttachments(current => [...current, ...added].slice(0, 6))
  }

  return (
    <div className="composer-wrap">
      {matches.length ? (
        <div className="palette" role="listbox">
          {matches.map(command => (
            <button
              key={command.name}
              type="button"
              className="palette-row"
              onClick={() => {
                setText(`${command.name} `)
                input.current?.focus()
              }}
            >
              <span className="palette-name">{command.name}</span>
              <span className="palette-desc">{command.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className={`composer ${remote ? 'remote' : ''} ${online ? '' : 'offline'}`}>
        {remote ? (
          <div className="destination">
            <MonitorIcon size={16} />
            <span>
              {chat.held ? (
                chat.held
              ) : chat.shared?.windowless ? (
                <>
                  Runs on <strong>your PC</strong>
                </>
              ) : chat.shared?.holder === 'pc-shared' || chat.watch?.holder === 'pc-window' ? (
                <>
                  To the Hermes window on <strong>your PC</strong>
                </>
              ) : (
                <>
                  To the chat open in <strong>the desktop app</strong>
                </>
              )}
            </span>
          </div>
        ) : null}
        {attachments.length ? (
          <div className="attachments">
            {attachments.map((a, i) => (
              <div key={i} className="attachment">
                <img src={a.dataUrl} alt="" />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => setAttachments(current => current.filter((_, j) => j !== i))}
                >
                  <CloseIcon size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
          <button type="button" className="icon-btn round" aria-label="Add photos" onClick={() => picker.current?.click()}>
            <PlusIcon size={20} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={event => {
              void onFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <textarea
            ref={input}
            aria-label="Message"
            rows={1}
            value={text}
            placeholder={placeholder}
            enterKeyHint={touch ? 'enter' : 'send'}
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          {chat.running && online && !chat.watch ? (
            <button
              type="button"
              className="send stop"
              aria-label="Stop"
              onClick={() => {
                haptic()
                void stop()
              }}
            >
              <StopIcon size={18} />
            </button>
          ) : null}
          {chat.running && !canSend && !chat.watch ? null : (
            <button
              type="button"
              className="send"
              aria-label={chat.running ? 'Send follow-up' : 'Send'}
              disabled={!canSend}
              onClick={() => void submit()}
            >
              <SendIcon size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
