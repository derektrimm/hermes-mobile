// Files a reply hands over: "MEDIA:<path>" (Hermes's delivery tag, as the desktop app reads it) and
// Markdown images of a local path. They come out of the text and show as pictures, players and file
// rows instead; the server reads each one through the chat's own backend (/hm/file).

import { fileAllowed, fileExtension } from '../../server/files.mjs'

export type MediaKind = 'image' | 'video' | 'audio' | 'text' | 'file'

export interface MediaRef {
  path: string
  name: string
  kind: MediaKind
  /** Whether the phone may open it (server/files.mjs); otherwise only its name shows. */
  viewable: boolean
}

// The extensions Hermes delivers (gateway/platforms/base.py MEDIA_DELIVERY_EXTS, mirrored by the
// desktop app): they end a path that has spaces in it.
const DELIVERY_EXTS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'mp4', 'mov', 'avi', 'mkv', 'webm', '3gp', 'mp3', 'm2a', 'wav', 'ogg',
  'opus', 'm4a', 'flac', 'pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'md', 'epub', 'xlsx', 'xls', 'ods', 'csv', 'tsv', 'json', 'xml',
  'yaml', 'yml', 'kmz', 'kml', 'geojson', 'gpx', 'pptx', 'ppt', 'odp', 'key', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'apk', 'ipa', 'html', 'htm'
]

const KINDS: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', ogg: 'audio', opus: 'audio', flac: 'audio',
  txt: 'text', md: 'text', csv: 'text'
}

const EXT = [...DELIVERY_EXTS].sort((a, b) => b.length - a.length).join('|')
// An unquoted path: starts at / or ~/, may hold spaces, ends on a delivered extension.
const ANCHORED = `(?:~/|/)\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${EXT})(?=[\\s\`"'*_,;:)\\]}]|MEDIA:|$)`
const TAG = new RegExp(`[\`"']?MEDIA:\\s*(\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${ANCHORED}|[^\\s\`"]+)[\`"']?`, 'gi')
const LOCAL_IMAGE = /!\[([^\]]*)\]\(\s*<?((?:file:\/\/)?(?:~\/|\/)[^)\s>]+)>?\s*\)/g

function unquote(value: string) {
  const trimmed = value.trim()
  const quote = trimmed[0]

  if (quote && quote === trimmed.at(-1) && ['"', "'", '`'].includes(quote)) {
    return trimmed.slice(1, -1)
  }

  return trimmed.replace(/[.,;:!?]+$/, '')
}

function ref(rawPath: string): MediaRef | null {
  let filePath = rawPath.replace(/^file:\/\//, '')

  try {
    filePath = decodeURI(filePath)
  } catch {
    // not percent-encoded
  }

  if (!/^(\/|~\/)/.test(filePath)) {
    return null
  }

  const extension = fileExtension(filePath)

  return {
    path: filePath,
    name: filePath.split('/').pop() || filePath,
    kind: KINDS[extension] ?? 'file',
    viewable: fileAllowed(filePath)
  }
}

export type ReplyPart = { kind: 'text'; text: string } | { kind: 'media'; media: MediaRef[] }

export interface SplitReply {
  /** The words, without the tags (what Copy copies). */
  text: string
  /** Every file named, in order, once each. */
  media: MediaRef[]
  /** Words and files in reading order: files on a line of their own show there; files named inside
   * a sentence show after its paragraph. */
  parts: ReplyPart[]
}

/**
 * The reply split into its words and the files its delivery tags name. While a reply streams
 * (`partial`) its last line may be a tag still arriving: it stays text until the line is done.
 */
export function splitMedia(text: string, partial = false): SplitReply {
  if (partial) {
    const cut = text.lastIndexOf('\n')

    if (cut < 0) {
      return { text, media: [], parts: text ? [{ kind: 'text', text }] : [] }
    }

    const done = splitMedia(text.slice(0, cut + 1))
    const tail = text.slice(cut + 1)
    const parts = [...done.parts]
    const last = parts[parts.length - 1]

    if (tail) {
      if (last?.kind === 'text') {
        parts[parts.length - 1] = { kind: 'text', text: `${last.text}\n${tail}` }
      } else {
        parts.push({ kind: 'text', text: tail })
      }
    }

    return { text: `${done.text}\n${tail}`, media: done.media, parts }
  }

  if (!text.includes('MEDIA:') && !/!\[[^\]]*\]\(\s*<?(file:\/\/|~\/|\/)/.test(text)) {
    return { text, media: [], parts: text ? [{ kind: 'text', text }] : [] }
  }

  const media: MediaRef[] = []
  const parts: ReplyPart[] = []
  const seen = new Set<string>()
  const words: string[] = []
  let segment: string[] = []
  let pending: MediaRef[] = []
  let fenced = false

  const tidy = (lines: string[]) => lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const flushText = () => {
    const chunk = tidy(segment)

    if (chunk) {
      parts.push({ kind: 'text', text: chunk })
    }

    segment = []
  }
  const pushMedia = (files: MediaRef[]) => {
    const last = parts[parts.length - 1]

    if (!files.length) {
      return
    }

    if (last?.kind === 'media') {
      last.media.push(...files)
    } else {
      parts.push({ kind: 'media', media: files })
    }
  }

  for (const line of text.split('\n')) {
    // Code shows as written: a tag in an example is not a delivery.
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced
    }

    if (fenced || /^\s{0,3}(```|~~~)/.test(line)) {
      segment.push(line)
      words.push(line)
      continue
    }

    const found: MediaRef[] = []
    const take = (file: MediaRef | null) => {
      if (file && !seen.has(file.path)) {
        seen.add(file.path)
        media.push(file)
        found.push(file)
      }
    }
    const kept = line
      .replace(TAG, (match, captured: string, offset: number) => {
        const file = inInlineCode(line, offset) ? null : ref(unquote(captured))

        if (!file) {
          return match
        }

        take(file)

        return ''
      })
      .replace(LOCAL_IMAGE, (match, _alt: string, target: string, offset: number) => {
        const file = inInlineCode(line, offset) ? null : ref(target)

        if (!file) {
          return match
        }

        take(file)

        return ''
      })

    if (kept === line) {
      segment.push(line)
      words.push(line)
    } else if (!kept.trim()) {
      // A line of tags only: the files show right here.
      flushText()
      pushMedia([...pending, ...found])
      pending = []
    } else {
      const sentence = kept
        .replace(/(\S)[^\S\n]{2,}/g, '$1 ')
        .replace(/(\S) ([,.;:!?])(?=\s|$)/g, '$1$2')
        .trimEnd()
      segment.push(sentence)
      words.push(sentence)
      pending.push(...found)

      // The paragraph ends at a blank line or the end: its files follow it.
    }

    if (!line.trim() && pending.length) {
      flushText()
      pushMedia(pending)
      pending = []
    }
  }

  flushText()
  pushMedia(pending)

  return { text: tidy(words), media, parts }
}

function inInlineCode(line: string, offset: number) {
  return ((line.slice(0, offset).match(/`/g) ?? []).length % 2) === 1
}

/** Where the phone reads a file: through the server, from the backend that owns the chat. */
export function mediaUrl(file: MediaRef, chat: { backend: string; profile: string }) {
  const query = new URLSearchParams({ path: file.path, profile: chat.profile || 'default', backend: chat.backend || 'main' })

  return `/hm/file?${query}`
}
