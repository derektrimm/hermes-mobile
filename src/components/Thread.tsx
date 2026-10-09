import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { copyText } from '../lib/clipboard'
import { friendlyTool } from '../lib/hermes'
import { handleCopyClick, renderMarkdown } from '../lib/markdown'
import type { Chat, Todo } from '../lib/store'
import type { AssistantItem, Item, NoticeItem, ToolItem, UserItem } from '../lib/transcript'
import { ArrowDownIcon, BrainIcon, CheckIcon, ChevronIcon, CloseIcon, CopyIcon, ImageIcon, ListIcon, toolIcon } from './icons'

interface Thought {
  kind: 'thought'
  id: string
  text: string
}

type Step = ToolItem | Thought

type Block =
  | { type: 'user'; item: UserItem }
  | { type: 'assistant'; item: AssistantItem; last: boolean }
  | { type: 'notice'; item: NoticeItem }
  | { type: 'work'; id: string; steps: Step[]; active: boolean }

function toBlocks(items: Item[], running: boolean): Block[] {
  const blocks: Block[] = []
  let steps: Step[] = []

  const flush = (active: boolean) => {
    if (steps.length) {
      blocks.push({ type: 'work', id: `w-${steps[0].id}`, steps, active })
      steps = []
    }
  }

  for (const item of items) {
    if (item.kind === 'tool') {
      steps.push(item)
    } else if (item.kind === 'assistant') {
      if (item.reasoning?.trim()) {
        steps.push({ kind: 'thought', id: `th-${item.id}`, text: item.reasoning.trim() })
      }

      if (item.text.trim()) {
        flush(false)
        blocks.push({ type: 'assistant', item, last: false })
      }
    } else {
      flush(false)
      blocks.push(item.kind === 'user' ? { type: 'user', item } : { type: 'notice', item })
    }
  }

  flush(running)

  // The answer that closes a turn carries the copy action.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]

    if (block.type === 'assistant') {
      blocks[i] = { ...block, last: !block.item.streaming }
      break
    }

    if (block.type === 'user' || block.type === 'work') {
      break
    }
  }

  return blocks
}

const VERBS: Array<[RegExp, string, string]> = [
  [/^(terminal|execute_code|process)$/, 'Ran', 'command'],
  [/^(read_file)$/, 'Read', 'file'],
  [/^(write_file|patch)$/, 'Edited', 'file'],
  [/^(search_files)$/, 'Searched', 'file search'],
  [/^(web_search)$/, 'Searched the web', 'search'],
  [/^(web_extract|browser.*)$/, 'Browsed', 'page'],
  [/^(skill_view|skills_list)$/, 'Read', 'skill'],
  [/^(delegate_task)$/, 'Delegated', 'task'],
  [/^(todo)$/, 'Updated', 'plan']
]

function describe(name: string): { verb: string; noun: string } {
  const bare = name.replace(/^mcp__/, '')

  for (const [re, verb, noun] of VERBS) {
    if (re.test(bare)) {
      return { verb, noun }
    }
  }

  return { verb: 'Used', noun: bare.replace(/_/g, ' ') }
}

// The running step reads in the present tense, a finished block in the past.
const PRESENT: Record<string, string> = {
  Ran: 'Running',
  Read: 'Reading',
  Edited: 'Editing',
  Searched: 'Searching',
  'Searched the web': 'Searching the web',
  Browsed: 'Browsing',
  Delegated: 'Delegating',
  Updated: 'Updating',
  Used: 'Using'
}

function stepLabel(tool: ToolItem, present = false): string {
  const { verb } = describe(tool.name)

  if (verb === 'Used') {
    return `${present ? 'Using' : 'Used'} ${friendlyTool(tool.name)}`
  }

  return present ? PRESENT[verb] ?? verb : verb
}

function summarize(steps: Step[]): string {
  const tools = steps.filter((s): s is ToolItem => s.kind === 'tool')

  if (!tools.length) {
    return 'Thought it through'
  }

  const counts = new Map<string, { verb: string; noun: string; n: number }>()

  for (const tool of tools) {
    const { verb, noun } = describe(tool.name)
    const key = `${verb}:${noun}`
    const entry = counts.get(key) ?? { verb, noun, n: 0 }
    entry.n += 1
    counts.set(key, entry)
  }

  // Tools without a friendly name are counted together rather than named one by one.
  const other = [...counts.values()].filter(c => c.verb === 'Used').reduce((n, c) => n + c.n, 0)
  const parts = [...counts.values()]
    .filter(c => c.verb !== 'Used')
    .sort((a, b) => b.n - a.n)
    .map(({ verb, noun, n }) => (verb === 'Searched the web' ? `${verb}${n > 1 ? ` ${n}×` : ''}` : `${verb} ${n} ${noun}${n === 1 ? '' : 's'}`))

  if (other) {
    parts.push(parts.length ? `${other} other tool${other === 1 ? '' : 's'}` : `Used ${other} tool${other === 1 ? '' : 's'}`)
  }

  return parts.length > 2 ? `${parts.slice(0, 2).join(', ')} and more` : parts.join(', ')
}

function seconds(value?: number | null) {
  if (value == null) {
    return ''
  }

  return value < 1 ? `${Math.round(value * 1000)} ms` : value < 60 ? `${value.toFixed(1)} s` : `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`
}

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const Icon = toolIcon(tool.name)
  const expandable = Boolean(tool.output)

  return (
    <div className={`step tool ${tool.status}`}>
      <button type="button" className="step-head" onClick={() => expandable && setOpen(o => !o)} aria-expanded={open}>
        <span className="step-icon">{tool.status === 'running' ? <span className="spinner" /> : <Icon size={16} />}</span>
        <span className="step-label">
          <span className="step-verb">{stepLabel(tool, tool.status === 'running')}</span>
          {tool.context ? <code className="step-context">{tool.context}</code> : null}
        </span>
        <span className="step-state">
          {tool.status === 'running' ? null : tool.status === 'error' ? (
            <CloseIcon size={14} className="bad" />
          ) : (
            <>
              {tool.duration != null && tool.duration >= 1 ? <span className="step-time">{seconds(tool.duration)}</span> : null}
              {expandable ? <ChevronIcon size={14} className={open ? 'turned' : ''} /> : null}
            </>
          )}
        </span>
      </button>
      {open && tool.output ? (
        <div className="step-output">
          <div className="step-output-bar">
            <span>{friendlyTool(tool.name)}</span>
            <button
              type="button"
              onClick={() => {
                void copyText(tool.output ?? '').then(ok => {
                  if (!ok) {
                    return
                  }

                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre>{tool.output.slice(0, 12000)}</pre>
        </div>
      ) : null}
    </div>
  )
})

function ThoughtRow({ thought }: { thought: Thought }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="step thought">
      <button type="button" className="step-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="step-icon">
          <BrainIcon size={15} />
        </span>
        <span className={`thought-text ${open ? 'open' : ''}`}>{thought.text}</span>
      </button>
    </div>
  )
}

function WorkBlock({ steps, active }: { steps: Step[]; active: boolean }) {
  const [open, setOpen] = useState(false)
  const latest = steps[steps.length - 1]
  const headline = active ? (latest.kind === 'tool' ? `${stepLabel(latest, true)} ${latest.context ?? ''}`.trim() : 'Thinking') : summarize(steps)

  return (
    <div className={`work ${active ? 'active' : ''}`}>
      <button type="button" className="work-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className={`work-title ${active ? 'shimmer' : ''}`}>{headline}</span>
        <span className="work-count">{steps.length}</span>
        <ChevronIcon size={15} className={open ? 'turned' : ''} />
      </button>
      {open ? (
        <div className="work-steps">
          {steps.map(step => (step.kind === 'tool' ? <ToolRow key={step.id} tool={step} /> : <ThoughtRow key={step.id} thought={step} />))}
        </div>
      ) : null}
    </div>
  )
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])

  return <div className="md" onClick={handleCopyClick} dangerouslySetInnerHTML={{ __html: html }} />
})

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className="icon-btn subtle"
      aria-label="Copy answer"
      onClick={() => {
        void copyText(text).then(ok => {
                  if (!ok) {
                    return
                  }

          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
    </button>
  )
}

function AssistantBlock({ item, last }: { item: AssistantItem; last: boolean }) {
  return (
    <div className={`msg assistant ${item.streaming ? 'streaming' : ''}`}>
      <Markdown text={item.text.replace(/^\s+/, '')} />
      {last ? (
        <div className="msg-actions">
          <CopyButton text={item.text.trim()} />
        </div>
      ) : null}
    </div>
  )
}

function UserBlock({ item }: { item: UserItem }) {
  // A turn started on another device: an empty marker until its prompt has been read back.
  if (item.peer && !item.text && !item.images?.length) {
    return null
  }

  return (
    <div className={`msg user ${item.pending ? 'pending' : ''} ${item.peer ? 'peer' : ''}`}>
      {item.images?.length ? (
        <div className="msg-images">
          {item.images.map((src, i) => (
            <img key={i} src={src} alt="" />
          ))}
        </div>
      ) : null}
      {item.photos ? (
        <div className="msg-photos">
          {Array.from({ length: item.photos }, (_, i) => (
            <span key={i} className="photo-chip">
              <ImageIcon size={15} />
              Photo
            </span>
          ))}
        </div>
      ) : null}
      {item.text ? <div className="bubble">{item.text}</div> : null}
    </div>
  )
}

function TodoCard({ todos }: { todos: Todo[] }) {
  const done = todos.filter(t => t.status === 'completed' || t.status === 'done').length

  return (
    <div className="todos">
      <div className="todos-head">
        <ListIcon size={15} />
        <span>
          Plan · {done}/{todos.length}
        </span>
      </div>
      <ul>
        {todos.map((todo, i) => (
          <li key={i} className={todo.status}>
            <span className="todo-dot" />
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Thread({ chat }: { chat: Chat }) {
  const blocks = useMemo(() => toBlocks(chat.items, chat.running), [chat.items, chat.running])
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [announce, setAnnounce] = useState('')
  const wasRunning = useRef(chat.running)
  const chatKey = chat.storedId ?? 'new'

  // VoiceOver hears when an answer is finished (the streaming itself would be noise).
  useEffect(() => {
    if (wasRunning.current && !chat.running) {
      setAnnounce(`Hermes finished${chat.watch ? ' on your PC' : ''}.`)
    }

    wasRunning.current = chat.running
  }, [chat.running, chat.watch])

  // A newly opened chat starts at its latest message.
  useLayoutEffect(() => {
    pinned.current = true
    const el = scroller.current

    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [chatKey, chat.loading])

  // Follow the stream while the reader is at the bottom; leave them alone when they scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current

    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [chat.items, chat.status])

  useEffect(() => {
    const el = scroller.current

    if (!el) {
      return
    }

    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      pinned.current = gap < 60
      setShowJump(gap > 240)
    }

    el.addEventListener('scroll', onScroll, { passive: true })

    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const lastIsUser = blocks.length > 0 && blocks[blocks.length - 1].type === 'user'
  const showStatus = chat.running && (chat.status || lastIsUser)

  return (
    <>
    <div className="thread" ref={scroller}>
      <div className="thread-inner">
        {blocks.map(block => {
          switch (block.type) {
            case 'user':
              return <UserBlock key={block.item.id} item={block.item} />
            case 'assistant':
              return <AssistantBlock key={block.item.id} item={block.item} last={block.last} />
            case 'notice':
              return block.item.output ? (
                <pre key={block.item.id} className={`cmd-output ${block.item.tone}`}>
                  {block.item.text}
                </pre>
              ) : (
                <div key={block.item.id} className={`notice ${block.item.tone}`}>
                  {block.item.text}
                </div>
              )
            case 'work':
              return <WorkBlock key={block.id} steps={block.steps} active={block.active} />
          }
        })}
        {chat.running && chat.todos.length ? <TodoCard todos={chat.todos} /> : null}
        {showStatus ? (
          <div className={`status-line ${chat.watch ? 'remote' : ''}`}>
            <span className="pulse" />
            <span className="shimmer">{chat.status || 'Thinking…'}</span>
          </div>
        ) : null}
        {chat.queued.map(q => (
          <div key={q.id} className="msg user pending">
            <div className="bubble">{q.text}</div>
            <span className="queued-label">Queued</span>
          </div>
        ))}
      </div>
    </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {showJump ? (
        <button
          type="button"
          className="jump"
          aria-label="Scroll to latest"
          onClick={() => {
            pinned.current = true
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
          }}
        >
          <ArrowDownIcon size={18} />
        </button>
      ) : null}
    </>
  )
}
