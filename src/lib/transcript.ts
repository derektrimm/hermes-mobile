import type { StoredMessage } from './api'
import type { TranscriptMessage } from '../../vendor/hermes-shared/gateway-contract.generated'

// One conversation as the phone draws it. Assistant text, tool steps and reasoning arrive in order;
// the view groups the steps between two answers into one collapsible "worked" block.

export interface UserItem {
  kind: 'user'
  id: string
  text: string
  images?: string[]
  pending?: boolean
  /** Typed on another device (the PC window, the desktop app) while this chat was open here. */
  peer?: boolean
  /** Photos stored by reference only (no picture data in history): shown as "Photo" chips. */
  photos?: number
}

export interface AssistantItem {
  kind: 'assistant'
  id: string
  text: string
  reasoning?: string
  streaming?: boolean
}

export interface ToolItem {
  kind: 'tool'
  id: string
  name: string
  context?: string | null
  status: 'running' | 'done' | 'error'
  duration?: number | null
  output?: string | null
}

export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  tone: 'info' | 'warn' | 'error'
  /** Command output: drawn as preformatted text, since commands align their columns with spaces. */
  output?: boolean
}

export type Item = UserItem | AssistantItem | ToolItem | NoticeItem

let counter = 0

export const localId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

/** Text of a message `content`, which is a string or a list of typed parts. */
// Hermes stores a prompt's attached pictures as "@image:<path>" lines before the text, and a
// native-vision part as a "[screenshot]" line (desktop app: lib/embedded-images.ts). They are
// pictures, not words: lift them out of the bubble text.
const IMAGE_REF_LINE = /^@image:[^\n]*\n?/gm
const SCREENSHOT_LINE = /^\[screenshot\]\n?/gm

export function userContent(content: unknown): Pick<UserItem, 'text' | 'images' | 'photos'> {
  const images = contentImages(content)
  let refs = 0
  let text = contentText(content).replace(IMAGE_REF_LINE, () => {
    refs++

    return ''
  })

  if (refs) {
    text = text.replace(SCREENSHOT_LINE, '')
  }

  // Pictures that came back as data are shown as pictures; the rest as chips.
  const photos = Math.max(0, refs - (images?.length ?? 0))

  return { text: text.trim(), images, ...(photos ? { photos } : {}) }
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') {
          return part
        }

        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text
        }

        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  return ''
}

/** Images inside a message `content` list (data: or http URLs). */
export function contentImages(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return []
  }

  const out: string[] = []

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue
    }

    const p = part as Record<string, unknown>
    const url = (p.image_url as { url?: string } | undefined)?.url ?? (typeof p.url === 'string' ? p.url : undefined)

    if ((p.type === 'image_url' || p.type === 'image') && typeof url === 'string') {
      out.push(url)
    }
  }

  return out
}

/** A one-line description of a tool call from its arguments, for history rows that carry no context. */
export function argsContext(args: unknown): string | null {
  if (!args || typeof args !== 'object') {
    return null
  }

  const a = args as Record<string, unknown>

  for (const key of ['command', 'path', 'file_path', 'query', 'url', 'name', 'pattern', 'code', 'goal', 'prompt']) {
    const value = a[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim().split('\n')[0].slice(0, 160)
    }
  }

  return null
}

// Context compaction stores its summary as an ordinary row whose text carries these markers
// (agent/context_compressor.py). A merged row keeps the reply that preceded the summary.
const PRIOR_HEADER = '[PRIOR CONTEXT — for reference only; not a new message]'
const PRIOR_END = '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]'
const COMPACTION = '[CONTEXT COMPACTION — REFERENCE ONLY]'
const COMPACTED_NOTE = 'Earlier messages were summarized to keep the conversation within context'

/** Split a compaction row into the reply it carried (if any); null when the row is not one. */
export function compactionReply(text: string): { reply: string } | null {
  const head = text.trimStart()

  if (head.startsWith(PRIOR_HEADER)) {
    const end = head.indexOf(PRIOR_END)

    return { reply: (end >= 0 ? head.slice(PRIOR_HEADER.length, end) : '').trim() }
  }

  if (head.startsWith(COMPACTION) || head.slice(0, 200).includes(COMPACTION)) {
    return { reply: '' }
  }

  return null
}

function pushCompaction(items: Item[], id: string, reply: string) {
  if (reply) {
    items.push({ kind: 'assistant', id, text: reply })
  }

  items.push({ kind: 'notice', id: `${id}-c`, text: COMPACTED_NOTE, tone: 'info' })
}

// Rows the gateway marks as system bookkeeping rather than something the user typed.
const SYSTEM_NOTES: Record<string, (text: string) => string> = {
  model_switch: text => text.trim() || 'Model switched',
  personality_switch: text => text.trim() || 'Personality switched',
  auto_continue: () => 'Hermes continued on its own',
  async_delegation_complete: () => 'A background task finished'
}

/** Transcript rows from `session.resume` / `session.activate` (display-ready). */
export function fromTranscript(messages: TranscriptMessage[]): Item[] {
  const items: Item[] = []

  messages.forEach((m, index) => {
    const id = m.row_id != null ? `r${m.row_id}` : m.tool_call_id ? `t${m.tool_call_id}` : `h${index}`
    const text = (typeof m.text === 'string' ? m.text : '') || contentText(m.content)

    if (m.display_kind === 'hidden') {
      return
    }

    const note = m.display_kind ? SYSTEM_NOTES[m.display_kind] : undefined
    const compacted = m.role !== 'tool' ? compactionReply(text) : null

    if (compacted) {
      pushCompaction(items, id, compacted.reply)

      return
    }

    if (note) {
      items.push({ kind: 'notice', id, text: note(text), tone: 'info' })

      return
    }

    if (m.role === 'user') {
      items.push({ kind: 'user', id, ...userContent(m.content) })
    } else if (m.role === 'assistant') {
      const reasoning = typeof m.reasoning === 'string' && m.reasoning.trim() ? m.reasoning : undefined

      if (text.trim() || reasoning) {
        items.push({ kind: 'assistant', id, text, reasoning })
      }
    } else if (m.role === 'tool') {
      // Hermes keeps the raw result on some rows (writes, patches, skill changes): show it, and
      // keep a failure a failure when the chat is reopened.
      const raw = m.content ?? null
      items.push({
        kind: 'tool',
        id,
        name: m.name || 'tool',
        context: m.context || argsContext(m.args),
        status: raw != null && toolFailed(typeof raw === 'string' ? raw : contentText(raw) || raw) ? 'error' : 'done',
        output: raw != null ? toolOutput(raw) : null
      })
    } else if (m.role === 'system' && text.trim()) {
      items.push({ kind: 'notice', id, text, tone: 'info' })
    }
  })

  return items
}

/** Whether a tool result reports failure: an error, a non-zero exit, success false, or a FAILED line. */
export function toolFailed(result: unknown): boolean {
  if (typeof result === 'string') {
    try {
      return toolFailed(JSON.parse(result))
    } catch {
      return /^\[[\w.-]+\][^\n]*\bFAILED\b/.test(result)
    }
  }

  if (!result || typeof result !== 'object') {
    return false
  }

  const r = result as Record<string, unknown>

  return Boolean(r.error) || (typeof r.exit_code === 'number' && r.exit_code !== 0) || r.success === false
}

function parseArgs(raw: string | undefined): unknown {
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function toolOutput(content: unknown): string | null {
  const text = contentText(content)

  if (!text) {
    return null
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const out = parsed.output ?? parsed.content ?? parsed.result ?? parsed.error

    return typeof out === 'string' ? out : JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

/** Raw stored rows (REST) for a conversation open elsewhere, mapped to the same items. */
export function fromStored(messages: StoredMessage[]): Item[] {
  const items: Item[] = []
  const tools = new Map<string, ToolItem>()

  for (const raw of messages) {
    // Scaffolding the model saw but a person never should; the API marks it (sessions.py).
    if (raw.display_kind === 'hidden') {
      continue
    }

    const m = raw.display_content != null ? { ...raw, content: raw.display_content } : raw
    const id = `s${m.id}`

    const compacted = m.role !== 'tool' ? compactionReply(contentText(m.content)) : null

    if (compacted) {
      pushCompaction(items, id, compacted.reply)
    } else if (m.role === 'user') {
      items.push({ kind: 'user', id, ...userContent(m.content) })
    }

    if (m.role === 'assistant') {
      const text = compacted ? '' : contentText(m.content)
      const reasoning = m.reasoning?.trim() ? m.reasoning : undefined

      if (text.trim() || reasoning) {
        items.push({ kind: 'assistant', id, text, reasoning })
      }

      for (const call of m.tool_calls || []) {
        const tool: ToolItem = {
          kind: 'tool',
          id: `t${call.id ?? `${m.id}-${tools.size}`}`,
          name: call.function?.name || 'tool',
          context: argsContext(parseArgs(call.function?.arguments)),
          status: 'running'
        }

        if (call.id) {
          tools.set(call.id, tool)
        }

        items.push(tool)
      }
    } else if (m.role === 'tool') {
      const tool = m.tool_call_id ? tools.get(m.tool_call_id) : undefined

      if (tool) {
        tool.status = toolFailed(contentText(m.content)) ? 'error' : 'done'
        tool.output = toolOutput(m.content)
      }
    }
  }

  return items
}
