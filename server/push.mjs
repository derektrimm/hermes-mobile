// Notifications that reach the phone while the app is closed.
//
//   Hermes, in every process on this host (plugin/hermes_mobile_push)
//     --unix socket--> server.mjs --> Notifier (what is worth a notification, and when)
//     --Web Push, encrypted for the phone (RFC 8291, signed per RFC 8292)--> the phone's push
//     service (Apple's, for a home-screen app on an iPhone) --> the phone
//
// The push service only relays ciphertext: the key that opens it was made on the phone.

import { createCipheriv, createECDH, createHash, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const KINDS = ['needs', 'replies', 'failures', 'tasks']
export const DEFAULT_PREFS = Object.freeze({ needs: true, replies: true, failures: true, tasks: true })

// Chats a person drives from a Hermes surface the phone can open. Messaging platforms deliver their
// own replies, editors (ACP) and automation have their own owners, and subagents report through
// their parent.
export const NOTIFY_SOURCES = new Set(['tui', 'desktop', 'cli'])

// Push services a subscription may point at. The server posts to whatever endpoint a device
// registers, so it only ever posts to these.
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/]

// ---------------------------------------------------------------- encoding

export const b64u = data => Buffer.from(data).toString('base64url')
export const fromB64u = text => Buffer.from(String(text), 'base64url')

// ---------------------------------------------------------------- RFC 8291 message encryption

/**
 * The aes128gcm body for one push message: header (salt, record size, sender key) and one record.
 * `salt` and `senderPrivate` are for tests against the RFC's example; leave them out otherwise.
 */
export function encrypt(keys, plaintext, { salt = randomBytes(16), senderPrivate } = {}) {
  const uaPublic = fromB64u(keys?.p256dh)
  const authSecret = fromB64u(keys?.auth)

  if (uaPublic.length !== 65 || uaPublic[0] !== 4) {
    throw new Error('subscription key p256dh is not an uncompressed P-256 point')
  }

  if (authSecret.length !== 16) {
    throw new Error('subscription auth secret is not 16 bytes')
  }

  const ecdh = createECDH('prime256v1')

  if (senderPrivate) {
    ecdh.setPrivateKey(senderPrivate)
  } else {
    ecdh.generateKeys()
  }

  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])

  if (record.length + 16 > 4096) {
    throw new Error('push payload too large')
  }

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header[20] = asPublic.length

  return Buffer.concat([header, asPublic, body])
}

// ---------------------------------------------------------------- RFC 8292 server identity (VAPID)

/** This server's push identity: made once, kept owner-only next to the subscriptions. */
export async function loadVapid(file) {
  let jwk = null

  try {
    jwk = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    jwk = privateKey.export({ format: 'jwk' })
    await writeOwnerOnly(file, JSON.stringify(jwk))
  }

  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' })
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]))

  return { privateKey, publicKey }
}

/** The Authorization header for one push service: a short-lived token signed with the server key. */
export function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 3600, sub: subject }))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' })

  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`
}

export function pushEndpointAllowed(endpoint) {
  try {
    const url = new URL(endpoint)

    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some(pattern => pattern.test(url.hostname))
  } catch {
    return false
  }
}

/** Post one message. Resolves to the push service's status (201 delivered, 404/410 subscription gone). */
export async function sendPush(subscription, message, { vapid, subject, urgency = 'normal', ttl = 86_400, topic } = {}) {
  const headers = {
    authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(ttl),
    urgency
  }

  if (topic) {
    // A newer message with the same topic replaces one the push service still holds for the phone.
    headers.topic = createHash('sha256').update(topic).digest('base64url').slice(0, 32)
  }

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers,
    body: encrypt(subscription.keys, JSON.stringify(message)),
    signal: AbortSignal.timeout(15_000)
  })
  await response.arrayBuffer().catch(() => null)

  return response.status
}

// ---------------------------------------------------------------- subscriptions

export class PushStore {
  constructor(file) {
    this.file = file
    this.subscriptions = null
  }

  async all() {
    if (!this.subscriptions) {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8'))
        this.subscriptions = Array.isArray(raw.subscriptions) ? raw.subscriptions : []
      } catch {
        this.subscriptions = []
      }
    }

    return this.subscriptions
  }

  async get(endpoint) {
    return (await this.all()).find(s => s.endpoint === endpoint) ?? null
  }

  async put({ endpoint, keys, device, prefs }) {
    const list = (await this.all()).filter(s => s.endpoint !== endpoint)
    const previous = (await this.all()).find(s => s.endpoint === endpoint)
    const entry = {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      device,
      created: previous?.created ?? Date.now(),
      prefs: cleanPrefs(prefs, previous?.prefs)
    }
    // A handful of devices at most; the oldest go first if a browser keeps re-registering.
    this.subscriptions = [...list, entry].slice(-20)
    await this.save()

    return entry
  }

  async setPrefs(endpoint, prefs) {
    const entry = await this.get(endpoint)

    if (!entry) {
      return null
    }

    entry.prefs = cleanPrefs(prefs, entry.prefs)
    await this.save()

    return entry
  }

  async remove(endpoint) {
    const list = await this.all()
    const kept = list.filter(s => s.endpoint !== endpoint)

    if (kept.length !== list.length) {
      this.subscriptions = kept
      await this.save()
    }
  }

  async save() {
    await writeOwnerOnly(this.file, JSON.stringify({ subscriptions: this.subscriptions }))
  }
}

/** Known kinds with boolean values from `prefs`, the rest from `base` (else on). */
export function cleanPrefs(prefs, base = DEFAULT_PREFS) {
  const out = { ...DEFAULT_PREFS, ...cleanBase(base) }

  for (const kind of KINDS) {
    if (typeof prefs?.[kind] === 'boolean') {
      out[kind] = prefs[kind]
    }
  }

  return out
}

function cleanBase(base) {
  return Object.fromEntries(KINDS.filter(kind => typeof base?.[kind] === 'boolean').map(kind => [kind, base[kind]]))
}

async function writeOwnerOnly(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(`${file}.tmp`, text, { mode: 0o600 })
  await chmod(`${file}.tmp`, 0o600)
  await rename(`${file}.tmp`, file)
}

// ---------------------------------------------------------------- text

/** A Markdown reply as a notification shows it: the words, without the markup around them. */
export function plainText(markdown) {
  if (typeof markdown !== 'string') {
    return ''
  }

  const lines = []
  let fenced = false

  for (let line of markdown.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }

    if (fenced) {
      lines.push(line)
      continue
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) {
      continue
    }

    line = line
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/, '$1• ')

    if (line.trimStart().startsWith('|')) {
      line = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(cell => cell.trim())
        .filter(Boolean)
        .join(' · ')
    }

    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      .replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '$1')
      .replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, '$1')
      .replace(/`/g, '')

    lines.push(line)
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** At most `max` characters, cut at a word where one is near. */
export function clip(text, max) {
  const flat = String(text || '').trim()

  if (flat.length <= max) {
    return flat
  }

  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')

  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Hermes's no-notification reply ("[SILENT]"), or nothing to show. */
export function isSilent(text) {
  const flat = String(text || '').trim()

  return !flat || /^\[silent\]$/i.test(flat)
}

const NEEDS_TEXT = {
  approval: prompt => (prompt ? `Wants to run: ${prompt}` : 'Waiting for your approval'),
  clarify: prompt => (prompt ? `Asks: ${prompt}` : 'Has a question for you'),
  sudo: () => 'Needs your sudo password'
}

/** The words of one notification (the server adds the chat's title). */
export function notificationBody(kind, detail) {
  switch (kind) {
    case 'needs': {
      const text = NEEDS_TEXT[detail.inputKind] ?? (() => 'Waiting for you')

      return clip(text(clip(String(detail.prompt || '').replace(/\s+/g, ' '), 200)), 240)
    }

    case 'replies':
      return clip(plainText(detail.text), 300) || 'Replied'

    case 'failures':
      return 'The turn stopped with an error. Open the chat to see what happened.'

    case 'tasks': {
      const summary = clip(plainText(detail.summary).replace(/\s+/g, ' '), 220)

      return summary ? `Task ${detail.status === 'failed' ? 'failed' : 'finished'}: ${summary}` : `A background task ${detail.status === 'failed' ? 'failed' : 'finished'}`
    }

    default:
      return ''
  }
}

// ---------------------------------------------------------------- what is worth a notification

// A reply that arrives this soon after a turn typed on the PC, in a chat open there, was most likely
// watched as it arrived; a longer turn notifies (whoever started it has likely walked away). A person
// waited on that long notifies too, if still waiting.
export const QUICK_TURN_MS = 120_000
// Hermes reports a turn's reply, then (in the same finalizer) whether the turn completed or failed.
// The reply waits for that verdict, at most this long.
export const REPLY_GRACE_MS = 120_000
// A message sent from the phone makes that chat's turns the phone's for this long.
export const PHONE_SENT_MS = 10 * 60_000

const MAX_TRACKED = 1000

function bounded(map, key, value) {
  map.delete(key)
  map.set(key, value)

  while (map.size > MAX_TRACKED) {
    map.delete(map.keys().next().value)
  }
}

/**
 * Turns the plugin's raw events into notifications. Every decision it needs from outside comes in:
 *   notify(kind, { session, profile, ...detail })  sends one (the server fills in title and devices)
 *   viewing(session)        a device has this chat on screen right now
 *   heldOnPc(session)       the chat is open in a PC window or the desktop app (async)
 */
export class Notifier {
  constructor({ notify, viewing, heldOnPc, now = Date.now, later = setTimeout, cancel = clearTimeout, log = () => {} }) {
    Object.assign(this, { notifyOut: notify, viewing, heldOnPc, now, later, cancel, log })
    this.turns = new Map() // session -> { turnId, start, platform }
    this.platforms = new Map() // session -> last platform seen
    this.replies = new Map() // `${session}\n${turnId}` -> { event, timer }
    this.inputs = new Map() // request_id -> { timer }
    this.children = new Set()
    this.phoneSent = new Map() // session -> when the phone last sent to it
    this.profiles = new Map() // session -> its Hermes profile
    this.done = new Set()
  }

  notePhoneSent(session) {
    if (session) {
      bounded(this.phoneSent, session, this.now())
    }
  }

  handle(event) {
    const session = typeof event.session_id === 'string' ? event.session_id : ''

    if (event.profile) {
      for (const id of [session, event.parent_session_id, event.child_session_id]) {
        if (id && !this.profiles.has(id)) {
          bounded(this.profiles, id, event.profile)
        }
      }
    }

    switch (event.event) {
      case 'turn_start':
        if (event.parent_session_id && session) {
          this.children.add(session)
        }

        if (session) {
          bounded(this.turns, session, { turnId: event.turn_id || '', start: this.now(), platform: event.platform || '' })
          bounded(this.platforms, session, event.platform || '')
        }

        return
      case 'reply':
        return this.onReply(session, event)
      case 'turn_end':
        return this.onTurnEnd(session, event)
      case 'input':
        return this.onInput(session, event)
      case 'input_resolved': {
        const open = this.inputs.get(event.request_id)

        if (open) {
          this.cancel(open.timer)
          this.inputs.delete(event.request_id)
        }

        return
      }
      case 'subagent_start':
        if (event.child_session_id) {
          this.children.add(event.child_session_id)
        }

        return
      case 'task_end':
        return this.onTaskEnd(event)
      default:
    }
  }

  ours(session, platform) {
    if (!session || this.children.has(session)) {
      return false
    }

    const source = platform || this.platforms.get(session) || ''

    return NOTIFY_SOURCES.has(source)
  }

  onReply(session, event) {
    if (!this.ours(session, event.platform)) {
      return
    }

    const key = `${session}\n${event.turn_id || ''}`
    const earlier = this.replies.get(key)

    if (earlier) {
      this.cancel(earlier.timer)
    }

    const turn = this.turns.get(session)
    const held = { event, start: turn && (!event.turn_id || turn.turnId === event.turn_id) ? turn.start : null, timer: null }
    held.timer = this.later(() => this.settleReplies(session, event.turn_id, 'done'), REPLY_GRACE_MS)
    bounded(this.replies, key, held)
  }

  onTurnEnd(session, event) {
    if (!session) {
      return
    }

    const turn = this.turns.get(session)

    if (turn && (!event.turn_id || !turn.turnId || turn.turnId === event.turn_id)) {
      this.turns.delete(session)
    }

    if (event.interrupted === true) {
      this.settleReplies(session, event.turn_id, 'drop')

      return
    }

    if (event.failed === true) {
      this.settleReplies(session, event.turn_id, 'drop')

      if (this.ours(session, event.platform)) {
        void this.emit('failures', session, `fail:${session}:${event.turn_id || this.now()}`, {}, turn?.start ?? null)
      }

      return
    }

    // Completed, ended short of completing (a step limit still answers), or the chat closed.
    this.settleReplies(session, event.turn_id, 'done')
  }

  settleReplies(session, turnId, outcome) {
    const keys = turnId ? [`${session}\n${turnId}`] : [...this.replies.keys()].filter(key => key.startsWith(`${session}\n`))

    for (const key of keys) {
      const held = this.replies.get(key)

      if (!held) {
        continue
      }

      this.cancel(held.timer)
      this.replies.delete(key)

      if (outcome === 'done' && !isSilent(held.event.text)) {
        void this.emit('replies', session, `reply:${key}`, { text: held.event.text }, held.start)
      }
    }
  }

  onInput(session, event) {
    if (!event.request_id || !this.ours(session, event.platform)) {
      return
    }

    const detail = { inputKind: event.kind, prompt: event.prompt }
    const turn = this.turns.get(session)
    const start = turn?.start ?? null
    const entry = { timer: null }
    this.inputs.set(event.request_id, entry)

    const attempt = async final => {
      if (this.inputs.get(event.request_id) !== entry) {
        return // answered meanwhile
      }

      const quiet = await this.quietReason('needs', session, start)

      if (this.inputs.get(event.request_id) !== entry) {
        return
      }

      if (quiet === 'at-pc' && !final) {
        // Probably being answered at the PC: ask again once it has waited as long as a quick turn.
        const wait = Math.max(1000, (start ?? this.now()) + QUICK_TURN_MS - this.now())
        entry.timer = this.later(() => void attempt(true), wait)

        return
      }

      this.inputs.delete(event.request_id)

      if (!quiet || (quiet === 'at-pc' && final)) {
        void this.emit('needs', session, `input:${event.request_id}`, detail, null)
      } else {
        this.log(`push: needs in ${session} quiet (${quiet})`)
      }
    }

    void attempt(false)
  }

  onTaskEnd(event) {
    const parent = event.parent_session_id || ''

    if (event.child_session_id) {
      this.children.delete(event.child_session_id)
    }

    if (!this.ours(parent, '')) {
      return
    }

    // A task that ends inside the turn that started it is part of that turn's reply.
    const running = this.turns.get(parent)

    if (running && event.parent_turn_id && running.turnId === event.parent_turn_id) {
      return
    }

    void this.emit('tasks', parent, `task:${event.child_session_id || this.now()}`, { summary: event.summary, status: event.child_status }, null)
  }

  /** Why a notification of this kind for this chat should stay quiet now; null to send it. */
  async quietReason(kind, session, start) {
    if (this.viewing(session)) {
      return 'viewing'
    }

    if ((kind === 'replies' || kind === 'needs') && start !== null && this.now() - start < QUICK_TURN_MS) {
      const sent = this.phoneSent.get(session)
      const phoneTurn = sent !== undefined && sent >= start - PHONE_SENT_MS

      if (!phoneTurn && (await this.heldOnPc(session).catch(() => false))) {
        return 'at-pc'
      }
    }

    return null
  }

  async emit(kind, session, id, detail, start) {
    if (this.done.has(id)) {
      return
    }

    this.done.add(id)

    if (this.done.size > MAX_TRACKED) {
      this.done.delete(this.done.values().next().value)
    }

    const quiet = kind === 'needs' ? null : await this.quietReason(kind, session, start)

    if (quiet) {
      this.log(`push: ${kind} in ${session} quiet (${quiet})`)

      return
    }

    await this.notifyOut(kind, { session, profile: this.profiles.get(session) ?? 'default', ...detail })
  }
}
