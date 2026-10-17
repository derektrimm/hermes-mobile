import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { type MediaRef, mediaUrl } from '../lib/media'
import { toast, useStore } from '../lib/store'
import { CloseIcon, FileIcon, ImageIcon, ShareIcon } from './icons'

const TEXT_LIMIT = 512 * 1024

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function fetchFile(url: string): Promise<Blob> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })

  if (!response.ok) {
    throw new Error((await response.text().catch(() => '')) || `HTTP ${response.status}`)
  }

  return response.blob()
}

/** Hand a file to the system: the share sheet (Save to Files, Photos, Books, …), else a download. */
async function shareFile(file: MediaRef, url: string) {
  try {
    const blob = await fetchFile(url)
    const shared = new File([blob], file.name, { type: blob.type })

    if (navigator.canShare?.({ files: [shared] })) {
      await navigator.share({ files: [shared] })

      return
    }

    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000)
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') {
      toast(`Could not open ${file.name}: ${errorText(error)}`, 'error')
    }
  }
}

interface Viewing {
  file: MediaRef
  url: string
}

/** Full screen: a picture fitted to the screen, or a text file, with Share and Close. */
function Viewer({ viewing, onClose }: { viewing: Viewing; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    if (viewing.file.kind !== 'text') {
      return
    }

    let live = true
    fetchFile(viewing.url)
      .then(blob => (blob.size > TEXT_LIMIT ? blob.slice(0, TEXT_LIMIT).text().then(t => `${t}\n…`) : blob.text()))
      .then(t => live && setText(t))
      .catch(error => live && setFailed(errorText(error)))

    return () => {
      live = false
    }
  }, [viewing])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)

    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="viewer" role="dialog" aria-modal="true" aria-label={viewing.file.name}>
      <div className="viewer-bar">
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon size={22} />
        </button>
        <span className="viewer-name">{viewing.file.name}</span>
        <button type="button" className="icon-btn" aria-label="Share" onClick={() => void shareFile(viewing.file, viewing.url)}>
          <ShareIcon size={21} />
        </button>
      </div>
      <div className="viewer-body" onClick={event => event.target === event.currentTarget && onClose()}>
        {viewing.file.kind === 'image' ? (
          <img src={viewing.url} alt={viewing.file.name} />
        ) : failed ? (
          <p className="viewer-note">{failed}</p>
        ) : text === null ? (
          <span className="spinner" />
        ) : (
          <pre className="viewer-text">{text}</pre>
        )}
      </div>
    </div>,
    document.body
  )
}

function Picture({ file, url, onOpen }: { file: MediaRef; url: string; onOpen: () => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  if (state === 'failed') {
    return <FileRow file={file} url={url} note="Not available" />
  }

  return (
    <button type="button" className={`media-picture ${state}`} aria-label={`Open ${file.name}`} onClick={onOpen}>
      <img src={url} alt={file.name} loading="lazy" onLoad={() => setState('ready')} onError={() => setState('failed')} />
    </button>
  )
}

function FileRow({ file, url, note, onOpen }: { file: MediaRef; url: string; note?: string; onOpen?: () => void }) {
  const open = file.viewable && !note
  const hint = note ?? (open ? (file.kind === 'text' ? 'Tap to read' : 'Tap to open or save') : 'Open it on the computer that made it')

  return (
    <button
      type="button"
      className={`media-file ${open ? '' : 'off'}`}
      disabled={!open}
      onClick={() => (onOpen ? onOpen() : void shareFile(file, url))}
    >
      {file.kind === 'image' ? <ImageIcon size={18} /> : <FileIcon size={18} />}
      <span className="media-file-text">
        <span className="media-file-name">{file.name}</span>
        <span className="media-file-hint">{hint}</span>
      </span>
    </button>
  )
}

/** The files a reply delivered, under its text. */
export function MediaFiles({ media }: { media: MediaRef[] }) {
  const backend = useStore(s => s.chat.backend)
  const profile = useStore(s => s.chat.profile)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const chat = { backend, profile }

  return (
    <div className="media">
      {media.map(file => {
        const url = mediaUrl(file, chat)

        if (!file.viewable) {
          return <FileRow key={file.path} file={file} url={url} />
        }

        switch (file.kind) {
          case 'image':
            return <Picture key={file.path} file={file} url={url} onOpen={() => setViewing({ file, url })} />
          case 'video':
            return <video key={file.path} className="media-video" src={url} controls playsInline preload="metadata" />
          case 'audio':
            return <audio key={file.path} className="media-audio" src={url} controls preload="metadata" />
          case 'text':
            return <FileRow key={file.path} file={file} url={url} onOpen={() => setViewing({ file, url })} />
          default:
            return <FileRow key={file.path} file={file} url={url} />
        }
      })}
      {viewing ? <Viewer viewing={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}
