import { type ReactNode, useEffect, useRef, useState } from 'react'

import { CloseIcon } from './icons'

/** A bottom sheet: slides up over a scrim, closes on a tap outside or a downward drag. */
export function Sheet({
  open,
  onClose,
  title,
  top = false,
  children
}: {
  open: boolean
  onClose: () => void
  title?: string
  /** Above other sheets: confirmations opened from inside a sheet. */
  top?: boolean
  children: ReactNode
}) {
  const [drag, setDrag] = useState(0)
  const start = useRef<number | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) {
      setDrag(0)

      return
    }

    // A dialog takes focus when it opens, gives it back when it closes, and closes on Escape
    // (VoiceOver's two-finger scrub sends Escape too).
    const before = document.activeElement as HTMLElement | null
    panel.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      before?.focus?.({ preventScroll: true })
    }
  }, [open])

  return (
    <>
      <div className={`scrim sheet-scrim ${top ? 'top' : ''} ${open ? 'show' : ''}`} onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        tabIndex={-1}
        className={`sheet ${top ? 'top' : ''} ${open ? 'open' : ''}`}
        style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-hidden={!open}
        inert={!open}
      >
        <div
          className="sheet-grab"
          onPointerDown={event => {
            start.current = event.clientY
            ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
          }}
          onPointerMove={event => {
            if (start.current !== null) {
              setDrag(Math.max(0, event.clientY - start.current))
            }
          }}
          onPointerUp={() => {
            start.current = null

            if (drag > 90) {
              onClose()
            }

            setDrag(0)
          }}
        >
          <span />
        </div>
        {title ? <h2 className="sheet-title">{title}</h2> : null}
        <button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
        <div className="sheet-body">{open ? children : null}</div>
      </div>
    </>
  )
}
