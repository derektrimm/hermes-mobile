import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { type Attachment, commandCatalog, send, steer, stop } from '../lib/hermes'
import { drafts, saveDraft } from '../lib/drafts'
import { haptic } from '../lib/haptics'
import { SERVER } from '../lib/site'
import { type Chat, setState, toast, useStore } from '../lib/store'
import { CloseIcon, FileIcon, MonitorIcon, PlusIcon, SendIcon, StopIcon } from './icons'

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

  return { name: file.name.replace(/\.\w+$/, '') + '.jpg', dataUrl: canvas.toDataURL('image/jpeg', 0.85), kind: 'image' }
}

// Anything else goes as it is, into the chat's workspace; the whole file rides the phone's network.
const FILE_LIMIT = 20 * 1024 * 1024

function readFile(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name || 'file', dataUrl: String(reader.result), kind: 'file' })
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

// Pictures the browser can draw are resized; others (HEIC on some browsers, SVG) go as files.
const DRAWN = /^image\/(jpeg|png|gif|webp|bmp|heic|heif|avif)$/

async function attachment(file: File): Promise<Attachment> {
  if (DRAWN.test(file.type)) {
    try {
      return await shrink(file)
    } catch {
      // a picture this browser cannot decode: send it as it is
    }
  }

  return readFile(file)
}

export function Composer({ chat }: { chat: Chat }) {
  const key = chat.storedId ?? `new:${chat.profile}`
  const [text, setText] = useState(() => drafts.get(key) ?? '')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  // While a turn runs, a message waits for it to end, or steers it at its next step.
  const [steering, setSteering] = useState(false)
  const [commands, setCommands] = useState<Array<{ name: string; description: string }> | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!chat.running) {
      setSteering(false)
    }
  }, [chat.running])

  useEffect(() => {
    setText(drafts.get(key) ?? '')
    setAttachments([])
    setSteering(false)
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
      ? steering
        ? 'Steer this turn'
        : 'Add a follow-up'
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

    const ok = steering && chat.running && !files.length ? await steer(body) : await send(body, files)
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

    const picked = [...files]
    const tooBig = picked.filter(f => !DRAWN.test(f.type) && f.size > FILE_LIMIT)

    if (tooBig.length) {
      toast(`${tooBig.map(f => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over 20 MB. Send ${tooBig.length === 1 ? 'it' : 'them'} from the PC.`, 'error')
    }

    const results = await Promise.allSettled(picked.filter(f => !tooBig.includes(f)).map(attachment))
    const added = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))

    if (results.some(r => r.status === 'rejected')) {
      toast('A file could not be read on this phone.', 'error')
    }

    setAttachments(current => [...current, ...added].slice(0, 6))
  }

  const showMode = chat.running && online && !chat.watch && !attachments.length && (text.trim().length > 0 || steering)

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
              <div key={i} className={`attachment ${a.kind}`}>
                {a.kind === 'image' ? (
                  <img src={a.dataUrl} alt="" />
                ) : (
                  <span className="attachment-file">
                    <FileIcon size={16} />
                    <span>{a.name}</span>
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${a.kind === 'image' ? 'photo' : a.name}`}
                  onClick={() => setAttachments(current => current.filter((_, j) => j !== i))}
                >
                  <CloseIcon size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {showMode ? (
          <div className="followup-mode" role="radiogroup" aria-label="While Hermes works">
            <button type="button" role="radio" aria-checked={!steering} className={steering ? '' : 'on'} onClick={() => setSteering(false)}>
              After this turn
            </button>
            <button type="button" role="radio" aria-checked={steering} className={steering ? 'on' : ''} onClick={() => setSteering(true)}>
              Steer now
            </button>
          </div>
        ) : null}
        <div className="composer-row">
          <button type="button" className="icon-btn round" aria-label="Add photos or files" onClick={() => picker.current?.click()}>
            <PlusIcon size={20} />
          </button>
          <input
            ref={picker}
            type="file"
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
              aria-label={chat.running ? (steering && !attachments.length ? 'Steer' : 'Send follow-up') : 'Send'}
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
