// Hermes Mobile server: serves the phone app and bridges it to the Hermes backend on this host.
//
//   phone --https (tailscale serve, tailnet only)--> this server (unix socket) --> Hermes dashboard
//                                                                                backend (:9119)
//
// The backend's session token never reaches the phone: this server reads it from the backend and
// adds it to every proxied request. Only allow-listed devices of the tailnet owner get in, and only
// the API routes the app uses are proxied.

import { execFile } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { WebSocket, WebSocketServer } from 'ws'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.HOME || os.homedir()

// This deployment's own settings (who may connect, from which devices, at which address) live in
// .env.local next to the app, which is not committed. Values already in the environment win.
try {
  process.loadEnvFile(path.resolve(here, '../.env.local'))
} catch {
  // no local settings file: everything below falls back, and the app admits nobody
}

const config = {
  // A unix socket in a 0700 directory: only this user (and tailscaled, as root) can connect, so no
  // other account on the box can reach the app or forge the identity headers tailscale serve sets.
  socket: process.env.HM_SOCKET || '',
  port: Number(process.env.HM_PORT || 27623),
  host: process.env.HM_HOST || '127.0.0.1',
  backend: (process.env.HM_BACKEND || 'http://127.0.0.1:9119').replace(/\/$/, ''),
  hermesRoot: process.env.HM_HERMES_ROOT || path.join(HOME, '.hermes'),
  dist: process.env.HM_DIST || path.resolve(here, '../dist'),
  // The address the phone opens; tailscale serve does not forward the browser's Host header.
  origin: (process.env.HM_PUBLIC_ORIGIN || '').replace(/\/$/, ''),
  // The tailnet login allowed in. Empty admits nobody.
  logins: list(process.env.HM_ALLOWED_LOGINS || ''),
  // The devices allowed in, by MagicDNS name. Never the server itself: a request through tailscale
  // serve from the server carries the server's own node identity, so any account there (a CI runner,
  // say) would pass as the owner. Health checks and deploys use the unix socket instead.
  devices: list(process.env.HM_ALLOWED_DEVICES || '')
}

function list(value) {
  return value
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// ---------------------------------------------------------------- tailnet identity

// Device names resolve to tailnet addresses through `tailscale status`; refreshed every minute so a
// device that changes address keeps working.
let allowedIps = new Set()

async function refreshAllowedIps() {
  try {
    const { stdout } = await run('tailscale', ['status', '--json'], { timeout: 10_000, maxBuffer: 8 << 20 })
    const status = JSON.parse(stdout)
    const ips = new Set()

    for (const node of [status.Self, ...Object.values(status.Peer || {})]) {
      const name = String(node?.DNSName || '').toLowerCase().replace(/\.$/, '')

      if (config.devices.includes(name)) {
        for (const ip of node.TailscaleIPs || []) {
          ips.add(ip)
        }
      }
    }

    allowedIps = ips
  } catch (error) {
    log('tailscale status failed; keeping the previous device list:', error.message)
  }
}

// tailscale serve sets Tailscale-User-Login and appends the peer to X-Forwarded-For, replacing any
// client-sent identity header. A request without them did not come through tailscale serve.
function identify(headers) {
  const login = String(headers['tailscale-user-login'] || '').trim().toLowerCase()
  const peer = String(headers['x-forwarded-for'] || '').split(',').pop().trim()

  if (!login || !peer) {
    return { ok: false, reason: 'not through tailscale serve' }
  }

  if (!config.logins.includes(login)) {
    return { ok: false, reason: `login ${login} is not allowed` }
  }

  if (!allowedIps.has(peer)) {
    return { ok: false, reason: `device ${peer} is not allowed` }
  }

  return { ok: true, login, peer }
}

// The tailnet identity belongs to the device, not to the page: a browser on an allowed device sends
// it with every request, whatever site the request came from. So a request must also come from this
// app's own page. WebSocket opens and writes need an Origin equal to the app's (browsers always send
// one there); reads refuse anything the browser marks cross-site.
function sameOrigin(req, { strict }) {
  const origin = req.headers.origin
  const site = req.headers['sec-fetch-site']

  if (origin !== undefined) {
    return origin === config.origin
  }

  if (site !== undefined) {
    return site === 'same-origin' || site === 'none'
  }

  return !strict
}

// ---------------------------------------------------------------- backends and their tokens

// Hermes allows one machine-level backend per host (the dashboard, config.backend); the desktop app
// starts its own backend over SSH. A live conversation can only be driven through the process that
// owns it, so the phone reaches each of them: 'main', and 'desktop-<pid>' for every desktop backend.

/**
 * Backends the phone can join besides 'main', by their listening port:
 *   desktop-<pid>  the Hermes desktop app's own backend (hermes serve --ssh-owner-nonce)
 *   pc-<pid>       a backend for PC terminal windows (hermes-hands: serve --isolated with the
 *                  PC's desktop hands, HERMES_MANAGED_DIR), whose windows are TUI clients of it
 */
async function joinableBackends() {
  const out = new Map()
  let listening = ''

  try {
    listening = (await run('ss', ['-ltnpH'], { timeout: 5000 })).stdout
  } catch (error) {
    log('ss failed; shared backends unavailable:', error.message)

    return out
  }

  for (const line of listening.split('\n')) {
    const port = line.match(/127\.0\.0\.1:(\d+)\s/)?.[1]
    const pid = line.match(/pid=(\d+),/)?.[1]

    if (!port || !pid) {
      continue
    }

    const info = await processInfo(Number(pid))

    if (!info?.cmdline.includes('serve')) {
      continue
    }

    if (info.cmdline.includes('--ssh-owner-nonce')) {
      out.set(`desktop-${pid}`, { url: `http://127.0.0.1:${port}`, kind: 'desktop-app' })
    } else if (info.cmdline.includes('--isolated') && (await hasHands(Number(pid)))) {
      out.set(`pc-${pid}`, { url: `http://127.0.0.1:${port}`, kind: 'pc-shared' })
    }
  }

  return out
}

async function hasHands(pid) {
  try {
    return (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').some(line => line.startsWith('HERMES_MANAGED_DIR='))
  } catch {
    return false
  }
}

const HOLDERS = {
  'desktop-app': 'the Hermes desktop app',
  'pc-shared': 'a Hermes window on your PC'
}

async function backendUrl(key) {
  if (!key || key === 'main') {
    return config.backend
  }

  if (!/^(desktop|pc)-\d+$/.test(key)) {
    return null
  }

  return (await joinableBackends()).get(key)?.url ?? null
}

// Every backend in loopback mode puts its session token into the page it serves at '/' (the desktop
// app reads it there too). Tokens rotate on restart, so each is re-read whenever its backend refuses it.
const tokens = new Map()
const tokenFetches = new Map()

async function backendToken(url, force = false) {
  if (tokens.has(url) && !force) {
    return tokens.get(url)
  }

  if (!tokenFetches.has(url)) {
    tokenFetches.set(
      url,
      (async () => {
        try {
          const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(10_000) })
          const html = await response.text()
          const match = html.match(/__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/)

          if (!match) {
            throw new Error(`no session token in the backend page (HTTP ${response.status})`)
          }

          tokens.set(url, match[1])

          return match[1]
        } finally {
          tokenFetches.delete(url)
        }
      })()
    )
  }

  return tokenFetches.get(url)
}

// ---------------------------------------------------------------- API allow-list

// A session id, never one of the sibling routes that share the path (stats, search, import, ...).
const ID = '(?!(?:stats|search|import|empty|prune|bulk-delete|owner-backfill)(?:/|$))[\\w.:-]+'

const API_ROUTES = [
  ['GET', /^\/api\/status$/],
  ['GET', /^\/api\/profiles$/],
  ['GET', /^\/api\/sessions$/],
  ['GET', /^\/api\/sessions\/search$/],
  ['GET', new RegExp(`^/api/sessions/${ID}$`)],
  ['GET', new RegExp(`^/api/sessions/${ID}/messages$`)],
  ['PATCH', new RegExp(`^/api/sessions/${ID}$`)],
  ['DELETE', new RegExp(`^/api/sessions/${ID}$`)]
]

function apiAllowed(method, pathname) {
  return API_ROUTES.some(([m, re]) => m === method && re.test(pathname))
}

const MAX_BODY = 1 << 20

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    req.on('data', chunk => {
      size += chunk.length

      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }))
        req.destroy()

        return
      }

      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function proxyApi(req, res, url) {
  let body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req)

  // The phone renames chats; archive, hide, pin and unread stay with the desktop surfaces.
  if (req.method === 'PATCH' && body?.length) {
    const parsed = JSON.parse(body.toString())
    body = Buffer.from(JSON.stringify({ title: String(parsed.title ?? ''), ...(parsed.profile ? { profile: String(parsed.profile) } : {}) }))
  }

  const send = async force => {
    const headers = { 'x-hermes-session-token': await backendToken(config.backend, force), accept: 'application/json' }

    if (body?.length) {
      headers['content-type'] = req.headers['content-type'] || 'application/json'
    }

    return fetch(`${config.backend}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: body?.length ? body : undefined,
      signal: AbortSignal.timeout(60_000)
    })
  }

  let response = await send(false)

  if (response.status === 401 || response.status === 403) {
    response = await send(true)
  }

  const payload = Buffer.from(await response.arrayBuffer())

  res.writeHead(response.status, {
    'content-type': response.headers.get('content-type') || 'application/json',
    'cache-control': 'no-store'
  })
  res.end(payload)
}

// ---------------------------------------------------------------- live sessions on this host

// Every Hermes chat surface (a desktop window's TUI, the desktop app's backend, the dashboard)
// takes a single-writer lease in <home>/runtime/active_sessions.json. Reading those files shows
// which conversations are open somewhere right now, and who has them.

async function profileHomes() {
  const homes = [{ profile: 'default', home: config.hermesRoot }]

  try {
    for (const entry of await readdir(path.join(config.hermesRoot, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        homes.push({ profile: entry.name, home: path.join(config.hermesRoot, 'profiles', entry.name) })
      }
    }
  } catch {
    // no profiles directory
  }

  return homes
}

// Background jobs a chat started (terminal background=true) live in every profile's processes.json
// while they run. Ending the window's Hermes kills them (agent close), and a job started on the PC
// cannot be re-adopted by the restarted window, so a chat with jobs running is never restarted.
async function runningJobs(sessionId, sshHost) {
  const seen = new Map()

  for (const { home } of await profileHomes()) {
    let text

    try {
      text = await readFile(path.join(home, 'processes.json'), 'utf8')
    } catch {
      continue // no checkpoint in this home
    }

    let jobs

    try {
      jobs = JSON.parse(text)
    } catch {
      // Caught mid-write or damaged: unknown is not "no jobs".
      seen.set(`unreadable:${home}`, { session_id: `unreadable:${home}`, pid_scope: 'host', pid: process.pid })
      continue
    }

    for (const job of Array.isArray(jobs) ? jobs : []) {
      const owners = [job.owner_task_id, job.session_key, job.parent_session_id]

      if (job.pid && owners.includes(sessionId) && !job.persist_on_release) {
        seen.set(job.session_id, job)
      }
    }
  }

  const jobs = [...seen.values()]
  const remote = jobs.filter(job => job.pid_scope !== 'host')
  const alive = new Set(jobs.filter(job => job.pid_scope === 'host' && existsSync(`/proc/${job.pid}`)).map(job => job.session_id))

  if (remote.length) {
    // A checkpoint can outlive its job; ask the PC which pids are still Hermes's. Unreachable counts as running.
    const pids = remote.map(job => Number(job.pid)).filter(Number.isInteger).join(' ')
    const probe = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', sshHost,
      `for p in ${pids}; do ps -o args= -p $p | grep -q hermes && echo $p; done; true`], { timeout: 15_000 }).catch(() => null)
    const living = probe ? new Set(probe.stdout.split(/\s+/).filter(Boolean)) : null

    for (const job of remote) {
      if (!living || living.has(String(job.pid))) {
        alive.add(job.session_id)
      }
    }
  }

  return jobs.filter(job => alive.has(job.session_id))
}

// Chats started on the phone. Hermes stores them with the same source as a terminal chat (the phone
// speaks the TUI's protocol, and changing the source would change the agent's platform hints), so
// the app keeps its own list to label them "Phone" on every device.
const PHONE_CHATS = path.join(HOME, '.local/state/hermes-mobile/phone-chats.json')
let phoneChats = null

async function readPhoneChats() {
  if (!phoneChats) {
    try {
      phoneChats = JSON.parse(await readFile(PHONE_CHATS, 'utf8'))
    } catch {
      phoneChats = []
    }
  }

  return phoneChats
}

async function addPhoneChat(id) {
  const list = (await readPhoneChats()).filter(existing => existing !== id)
  list.push(id)
  phoneChats = list.slice(-5000)
  await mkdir(path.dirname(PHONE_CHATS), { recursive: true })
  await writeFile(`${PHONE_CHATS}.tmp`, JSON.stringify(phoneChats))
  await rename(`${PHONE_CHATS}.tmp`, PHONE_CHATS)
}

// Whether a classic PC window must not be restarted right now, and why. Three independent signals,
// because each alone has a blind spot:
// - its screen: the busy placeholder ("msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel",
//   locales/en.yaml placeholder_busy) and the approval/clarify footers all end in "Ctrl+C cancel";
//   the placeholder disappears once something is typed, so the screen is not enough;
// - its saved conversation: a turn in flight leaves a user or tool row, or an assistant row asking
//   for tools, as the last active message. A turn that died mid-way leaves the same, so only a
//   recent one counts;
// - its input line: text typed there and not sent yet would be lost by the restart.
const MID_TURN_FRESH_S = 30 * 60

async function windowBusy(tmux, home, sessionId, holderPid) {
  // Work running on the window's own threads that no file records: /bg tasks ("bg-task-<id>"),
  // /btw side questions, a sign-in, async subagents (their monitor thread lives only while one runs)
  // and background-job pollers. Thread names are truncated to 15 characters by the kernel.
  if (holderPid) {
    const names = await readdir(`/proc/${holderPid}/task`)
      .then(tids => Promise.all(tids.map(tid => readFile(`/proc/${holderPid}/task/${tid}/comm`, 'utf8').catch(() => ''))))
      .catch(() => null)

    if (!names) {
      return { busy: true, error: 'Could not check the PC window. The phone tries again shortly.' }
    }

    const work = names.map(n => n.trim()).filter(n => /^(bg-task-|btw-side|login$|async-delegate-|proc-poller)/.test(n))

    if (work.length) {
      return { jobs: work.length, error: 'This chat has background work running in its PC window that would stop if the window restarted.' }
    }
  }

  const screen = (await tmux('capture-pane', '-e', '-p', '-t', 'hermes')).stdout
  const lines = screen.split('\n').filter(line => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
  const plain = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))

  if (/Ctrl\+C cancel/i.test(plain.slice(-4).join('\n'))) {
    return { busy: true, error: 'It is in the middle of a turn. The phone joins when it finishes.' }
  }

  if (home && /^[\w.:-]{1,128}$/.test(sessionId)) {
    const { stdout } = await run('sqlite3', ['-readonly', '-separator', '|', path.join(home, 'state.db'),
      `select role, coalesce(finish_reason, ''), timestamp from messages where session_id = '${sessionId}' and active = 1 order by id desc limit 1`],
    { timeout: 5_000 })
    const [role, finish, at] = stdout.trim().split('|')
    const midTurn = role === 'user' || role === 'tool' || (role === 'assistant' && finish === 'tool_calls')

    if (midTurn && Date.now() / 1000 - Number(at) < MID_TURN_FRESH_S) {
      return { busy: true, error: 'It is in the middle of a turn. The phone joins when it finishes.' }
    }
  }

  // The prompt line: "<profile> ❯ " then either the italic placeholder or what has been typed.
  const prompt = [...lines].reverse().find(line => line.includes('❯ '))
  const typed = prompt ? prompt.slice(prompt.indexOf('❯ ') + 2) : ''

  if (typed.replace(/\x1b\[[0-9;]*m/g, '').trim() && !/^\s*(\x1b\[[0-9;]*m)*\x1b\[3m/.test(typed)) {
    return { draft: true, error: 'There is unsent text in the Hermes window on your PC. Send or clear it there, then send again here.' }
  }

  return null
}

// psutil's create_time (what Hermes stores as process_start_time): boot time + start ticks / CLK_TCK.
let bootTime = null
const CLK_TCK = 100

async function processStartTime(pid) {
  try {
    if (bootTime === null) {
      bootTime = Number((await readFile('/proc/stat', 'utf8')).match(/^btime (\d+)$/m)?.[1])
    }

    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const ticks = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19])

    return bootTime + ticks / CLK_TCK
  } catch {
    return null
  }
}

async function processInfo(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const ppid = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1])
    const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)

    return { pid, ppid, cmdline }
  } catch {
    return null
  }
}

// Who holds a lease: a desktop window (a TUI under the server's hermes-session tmux, which can be
// handed off), the Hermes desktop app's backend, this phone's own backend, or something else.
async function classifyHolder(pid) {
  const self = await processInfo(pid)

  if (!self) {
    return null
  }

  const joined = self.cmdline.join(' ')

  if (joined.includes('--ssh-owner-nonce')) {
    return { kind: 'desktop-app', label: HOLDERS['desktop-app'] }
  }

  if (joined.includes('--isolated') && joined.includes('serve') && (await hasHands(pid))) {
    return { kind: 'pc-shared', label: HOLDERS['pc-shared'] }
  }

  // Only the backend this app talks to is the phone's own; any other dashboard or serve on the server
  // (one started for another tool) is someone else's and is shown as such.
  if (/\b(dashboard|serve)\b/.test(joined) && new RegExp(`--port[ =]${new URL(config.backend).port || 80}\\b`).test(joined)) {
    return { kind: 'phone-backend', label: 'Hermes Mobile' }
  }

  let current = self

  for (let depth = 0; depth < 8 && current && current.ppid > 1; depth++) {
    const parent = await processInfo(current.ppid)
    const socket = parent?.cmdline.find((arg, i) => parent.cmdline[i - 1] === '-L' && arg.startsWith('hermes-'))

    if (parent?.cmdline[0]?.endsWith('tmux') && socket) {
      return { kind: 'pc-window', label: 'a Hermes window on your PC', tmux: socket }
    }

    current = parent
  }

  return { kind: 'other', label: 'another Hermes process' }
}

async function liveSessions() {
  const out = []

  for (const { profile, home } of await profileHomes()) {
    let entries = []

    try {
      const raw = JSON.parse(await readFile(path.join(home, 'runtime', 'active_sessions.json'), 'utf8'))
      entries = Array.isArray(raw) ? raw : raw.entries || []
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry?.session_id || !Number.isInteger(entry.pid)) {
        continue
      }

      const holder = await classifyHolder(entry.pid)

      if (holder) {
        const backend =
          holder.kind === 'desktop-app'
            ? `desktop-${entry.pid}`
            : holder.kind === 'pc-shared'
              ? `pc-${entry.pid}`
              : holder.kind === 'phone-backend'
                ? 'main'
                : null
        out.push({
          session_id: entry.session_id,
          profile,
          pid: entry.pid,
          surface: entry.surface || null,
          started_at: entry.started_at || null,
          holder: holder.kind,
          holder_label: holder.label,
          backend,
          process_start_time: entry.process_start_time ?? null
        })
      }
    }
  }

  return out
}

// A chat open in a shared backend (the desktop app, a PC window's TUI) takes its lease only on its
// next turn, so the lease files miss a chat that is merely open. Each one is asked directly.
const probes = new Map()

function probeBackend(url) {
  const previous = probes.get(url)

  if (previous && !previous.dead) {
    return previous
  }

  const probe = { ws: null, dead: false, next: 0, pending: new Map(), ready: null }

  const fail = () => {
    probe.dead = true
    probe.pending.forEach(call => call.reject(new Error('probe closed')))
    probe.pending.clear()
  }

  probe.ready = (async () => {
    // A probe that existed before died, most likely because the backend restarted with a new token.
    const value = await backendToken(url, Boolean(previous))

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(value)}`)
      probe.ws = ws
      // A backend that accepts the connection but never finishes the handshake must not hold every
      // caller (and so /hm/live and every chat being opened) forever.
      const timer = setTimeout(() => {
        reject(new Error('probe handshake timed out'))
        ws.terminate()
      }, 5_000)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      ws.once('close', () => {
        clearTimeout(timer)
        reject(new Error('probe closed before it opened'))
      })
      ws.on('close', fail)
      ws.on('message', raw => {
        let frame

        try {
          frame = JSON.parse(raw.toString())
        } catch {
          return
        }

        const call = frame.id != null ? probe.pending.get(frame.id) : undefined

        if (call) {
          probe.pending.delete(frame.id)
          frame.error ? call.reject(new Error(frame.error.message || 'rpc failed')) : call.resolve(frame.result)
        } else if (frame.method && frame.method !== 'event' && frame.id != null) {
          // A question meant for a real client: this probe never answers for anyone.
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'probe' } }))
        }
      })
    })
  })()
  probe.ready.catch(fail)
  probes.set(url, probe)

  return probe
}

async function probeCall(url, method, params) {
  const probe = probeBackend(url)
  await probe.ready
  const id = `p${++probe.next}`

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      probe.pending.delete(id)
      reject(new Error('probe timed out'))
    }, 5000)
    probe.pending.set(id, {
      resolve: value => (clearTimeout(timer), resolve(value)),
      reject: error => (clearTimeout(timer), reject(error))
    })
    probe.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

let sharedLiveCache = { at: 0, value: [] }
const sessionProfiles = new Map()

// active_list carries no profile, and a desktop backend lists its live chats whatever profile is
// asked for, so each chat's profile is looked up once in the profiles' session stores.
async function profileOf(sessionId) {
  if (sessionProfiles.has(sessionId)) {
    return sessionProfiles.get(sessionId)
  }

  for (const { profile } of await profileHomes()) {
    const response = await fetch(
      `${config.backend}/api/sessions/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(profile)}`,
      { headers: { 'x-hermes-session-token': await backendToken(config.backend) }, signal: AbortSignal.timeout(5000) }
    ).catch(() => null)

    if (response?.ok) {
      if (sessionProfiles.size > 2000) {
        sessionProfiles.clear()
      }

      sessionProfiles.set(sessionId, profile)

      return profile
    }
  }

  return null
}

async function sharedLive() {
  if (Date.now() - sharedLiveCache.at < 2000) {
    return sharedLiveCache.value
  }

  const out = []

  for (const [key, { url, kind }] of await joinableBackends()) {
    const pid = Number(key.slice(key.indexOf('-') + 1))

    try {
      const result = await probeCall(url, 'session.active_list', {})

      for (const item of result?.sessions || []) {
        // A chat with no messages yet is not stored anywhere, so its profile is unknown until the phone
        // joins it (the backend then names it); it is still listed.
        const profile = item.session_key ? await profileOf(item.session_key) : null

        if (item.session_key) {
          out.push({
            session_id: item.session_key,
            profile,
            pid,
            surface: kind === 'desktop-app' ? 'desktop' : 'tui',
            started_at: item.started_at ?? null,
            title: item.title || item.preview || null,
            status: item.status || null,
            holder: kind,
            holder_label: HOLDERS[kind],
            backend: key
          })
        }
      }
    } catch (error) {
      log(`desktop backend ${key} did not list its chats:`, error.message)
    }
  }

  sharedLiveCache = { at: Date.now(), value: out }

  return out
}

// Make a chat that is open in an older PC window (the classic CLI, one process with no gateway) one
// the phone can drive too, without closing the window: end that window's Hermes the way closing a
// terminal does (SIGHUP, which saves the conversation and releases its lease), then restart the same
// tmux pane as hermes-hands, a TUI client of the shared backend that keeps the PC's desktop hands.
// The PC window stays open and shows the same chat; the phone then joins it.
const sharesInFlight = new Map()

async function share(sessionId, profile) {
  const live = (await liveSessions()).find(s => s.session_id === sessionId && (!profile || s.profile === profile))

  if (!live) {
    return { status: 409, body: { ok: false, error: 'This chat is not open in a PC window any more.' } }
  }

  if (live.holder !== 'pc-window') {
    return { status: 200, body: { ok: true, already_shared: true, backend: live.backend } }
  }

  // The very process that took the lease (a recycled pid is not), still a Hermes window under
  // hermes-session, before anything is signalled.
  const holder = await classifyHolder(live.pid)
  const started = await processStartTime(live.pid)

  if (live.process_start_time == null || started == null || Math.abs(started - Number(live.process_start_time)) > 0.05) {
    return { status: 409, body: { ok: false, error: 'That window is not the one that opened this chat any more. Try again.' } }
  }

  if (holder?.kind !== 'pc-window' || !holder.tmux) {
    return { status: 409, body: { ok: false, error: 'The PC window changed. Try again.' } }
  }

  const env = Object.fromEntries(
    (await readFile(`/proc/${live.pid}/environ`, 'utf8'))
      .split('\0')
      .filter(Boolean)
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )

  if (!env.HERMES_MANAGED_DIR || !env.HERMES_DESKTOP_SSH_HOST) {
    return { status: 409, body: { ok: false, error: 'This window runs its commands on the server, not on your PC, so it cannot be shared this way.' } }
  }

  // Flags that only a standalone window keeps (hermes-hands opens such windows standalone on
  // purpose): a restart as a shared window would quietly drop them.
  const argv = (await readFile(`/proc/${live.pid}/cmdline`, 'utf8').catch(() => '')).split('\0')
  const pinned = argv.find(a => /^(-t|--toolsets|-s|--skills|--in|--usage-file|--max-turns|--yolo|--checkpoints|--worktree|-w|-m|--model|--provider|--reasoning)(=|$)/.test(a))

  if (pinned) {
    return {
      status: 409,
      body: { ok: false, pinned: true, error: `This PC window was opened with ${pinned.replace(/=.*/, '')}, which a shared window cannot keep. Reply in that window; the phone shows it live.` }
    }
  }

  const jobs = await runningJobs(sessionId, env.HERMES_DESKTOP_SSH_HOST)

  if (jobs.length) {
    const what = jobs.length === 1 ? 'a background job' : `${jobs.length} background jobs`

    return {
      status: 409,
      body: { ok: false, jobs: jobs.length, error: `This chat has ${what} running that would stop if its window restarted.` }
    }
  }

  const tmux = (...args) => run('tmux', ['-L', holder.tmux, ...args], { timeout: 10_000 })
  const home = (await profileHomes()).find(h => h.profile === (live.profile || 'default'))?.home
  const blocked = async () => (await windowBusy(tmux, home, sessionId, live.pid)) || null
  const first = await blocked()

  if (first) {
    return { status: 409, body: { ok: false, ...first } }
  }

  // Close the gap between looking and signalling: the window takes no keys while it is checked once
  // more, so a turn cannot start (and a draft cannot be typed) between the check and the restart.
  await tmux('select-pane', '-d', '-t', 'hermes')
  const last = await blocked().catch(error => ({ busy: true, error: String(error) }))

  if (last) {
    await tmux('select-pane', '-e', '-t', 'hermes').catch(() => undefined)

    return { status: 409, body: { ok: false, ...last } }
  }

  log(`share: restarting ${holder.tmux} (pid ${live.pid}) as a shared window for ${sessionId}`)
  const sessionTmuxConf = path.join(HOME, '.config/hermes/session-tmux.conf')

  // Whatever happens from here, the window ends up taking keys again with its normal hooks.
  try {
    // Keep the pane (and the PC window attached to it) when this Hermes exits.
    await tmux('set-hook', '-gu', 'pane-died')
    process.kill(live.pid, 'SIGHUP')

    // The classic CLI saves the chat and prints its "Resume this session with:" summary on SIGHUP,
    // but can then hang on teardown (seen: its ssh link to the PC kept the main thread in poll for
    // minutes), leaving a dead window. Once that summary is on screen the chat is saved and the
    // process has nothing left to do: give it a moment, then end it (TERM, then KILL). Without the
    // summary nothing is forced; after a minute the restart is abandoned and the window left as is.
    const deadline = Date.now() + 60_000
    // Still running: the same process (start time) and not a zombie waiting for tmux to reap it.
    const alive = async () => {
      const stat = await readFile(`/proc/${live.pid}/stat`, 'utf8').catch(() => '')
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)

      return Boolean(stat) && state !== 'Z' && (await processStartTime(live.pid)) === started
    }
    // It may exit on its own between the check and the signal.
    const signal = name => {
      try {
        process.kill(live.pid, name)
      } catch {
        // already gone
      }
    }
    let savedAt = 0

    while (Date.now() < deadline && (await alive())) {
      await new Promise(resolve => setTimeout(resolve, 300))

      if (!savedAt && /Resume this session with:/.test((await tmux('capture-pane', '-p', '-t', 'hermes').catch(() => ({ stdout: '' }))).stdout)) {
        savedAt = Date.now()
      }

      if (savedAt && Date.now() - savedAt > 3_000 && (await alive())) {
        log(`share: ${live.pid} saved its chat but did not exit; ending it`)
        signal('SIGTERM')

        for (let i = 0; i < 20 && (await alive()); i++) {
          await new Promise(resolve => setTimeout(resolve, 250))
        }

        if (await alive()) {
          signal('SIGKILL')

          for (let i = 0; i < 20 && (await alive()); i++) {
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }

        break
      }
    }

    if (await alive()) {
      return { status: 504, body: { ok: false, error: 'The PC window did not let go within a minute.' } }
    }

    const keep = ['HERMES_MANAGED_DIR', 'HERMES_DESKTOP_SSH_HOST', 'HERMES_DESKTOP_CWD', 'TERMINAL_SSH_SYNC_FILES', 'PATH', 'COLORTERM']
    const envArgs = keep.filter(k => env[k] !== undefined).flatMap(k => ['-e', `${k}=${env[k]}`])
    const chatProfile = live.profile || 'default'

    await tmux('respawn-pane', '-k', '-t', 'hermes', ...envArgs, '--', '/usr/bin/env',
      path.join(HOME, '.local/bin/hermes-hands'), '-p', chatProfile, '--resume', sessionId)
  } finally {
    await tmux('select-pane', '-e', '-t', 'hermes').catch(() => undefined)
    await tmux('source-file', sessionTmuxConf).catch(() => undefined)
  }

  // Ready when the shared backend lists the chat.
  for (let i = 0; i < 80; i++) {
    sharedLiveCache = { at: 0, value: [] }
    const joined = (await sharedLive()).find(l => l.session_id === sessionId)

    if (joined) {
      return { status: 200, body: { ok: true, backend: joined.backend } }
    }

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  return { status: 504, body: { ok: false, error: 'The window restarted but its chat did not come back within 40 s.' } }
}

// ---------------------------------------------------------------- static app

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}

async function serveStatic(res, pathname) {
  let decoded

  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end('bad path')

    return
  }

  const clean = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(config.dist, clean)

  if (!file.startsWith(config.dist)) {
    res.writeHead(400).end()

    return
  }

  let info = await stat(file).catch(() => null)

  if (!info?.isFile()) {
    // Client-side routes fall back to the app shell; a missing asset is a real 404.
    if (path.extname(clean)) {
      res.writeHead(404, SECURITY_HEADERS).end('not found')

      return
    }

    file = path.join(config.dist, 'index.html')
    info = await stat(file).catch(() => null)
  }

  if (!info) {
    res.writeHead(503, SECURITY_HEADERS).end('app not built')

    return
  }

  const ext = path.extname(file)
  const immutable = file.includes(`${path.sep}assets${path.sep}`)

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': TYPES[ext] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  })
  createReadStream(file).pipe(res)
}

// ---------------------------------------------------------------- HTTP

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local')

  try {
    if (url.pathname === '/healthz') {
      json(res, 200, { ok: true })

      return
    }

    const who = identify(req.headers)

    if (!who.ok) {
      log(`refused ${req.method} ${url.pathname}: ${who.reason}`)
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Hermes Mobile is only open to your own devices.')

      return
    }

    const reading = req.method === 'GET' || req.method === 'HEAD'

    if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/hm/')) && !sameOrigin(req, { strict: !reading })) {
      log(`refused cross-origin ${req.method} ${url.pathname} from ${req.headers.origin ?? req.headers['sec-fetch-site']}`)
      json(res, 403, { error: 'cross-origin request refused' })

      return
    }

    if (url.pathname === '/hm/live' && req.method === 'GET') {
      const leases = await liveSessions()
      const seen = new Set(leases.map(l => `${l.profile}:${l.session_id}`))
      const extra = (await sharedLive()).filter(l => !seen.has(`${l.profile}:${l.session_id}`))
      json(res, 200, {
        sessions: [...leases, ...extra],
        backends: ['main', ...(await joinableBackends()).keys()],
        phone_chats: await readPhoneChats()
      })

      return
    }

    if (url.pathname === '/hm/phone-chat' && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        json(res, 415, { ok: false, error: 'JSON required' })

        return
      }

      const body = JSON.parse((await readBody(req)).toString() || '{}')

      if (typeof body.session_id !== 'string' || !/^[\w.:-]{1,128}$/.test(body.session_id)) {
        json(res, 400, { ok: false, error: 'session_id required' })

        return
      }

      await addPhoneChat(body.session_id)
      json(res, 200, { ok: true })

      return
    }

    if (url.pathname === '/hm/share' && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        json(res, 415, { ok: false, error: 'JSON required' })

        return
      }

      const body = JSON.parse((await readBody(req)).toString() || '{}')

      if (typeof body.session_id !== 'string' || !/^[\w.:-]{1,128}$/.test(body.session_id)) {
        json(res, 400, { ok: false, error: 'session_id required' })

        return
      }

      // One restart per window at a time: a second phone asking meanwhile gets the first one's answer.
      let pending = sharesInFlight.get(body.session_id)

      if (!pending) {
        pending = share(body.session_id, typeof body.profile === 'string' ? body.profile : null).finally(() => sharesInFlight.delete(body.session_id))
        sharesInFlight.set(body.session_id, pending)
      }

      const result = await pending
      json(res, result.status, result.body)

      return
    }

    if (url.pathname.startsWith('/api/')) {
      if (!apiAllowed(req.method, url.pathname)) {
        json(res, 404, { error: 'not available to the phone app' })

        return
      }

      await proxyApi(req, res, url)

      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()

      return
    }

    await serveStatic(res, url.pathname)
  } catch (error) {
    log(`error on ${req.method} ${url.pathname}:`, error.message)

    if (!res.headersSent) {
      json(res, error.status || 502, { error: error.status ? error.message : 'Hermes backend unavailable' })
    } else {
      res.destroy()
    }
  }
})

// ---------------------------------------------------------------- WebSocket bridge

// Large enough for a long chat full of photos (the biggest stored chat today is under 5 MB of text).
const MAX_FRAME = 128 << 20
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local')
  const who = identify(req.headers)

  if (url.pathname !== '/api/ws' || !who.ok || !sameOrigin(req, { strict: true })) {
    log(`refused websocket ${url.pathname}: ${!who.ok ? who.reason : url.pathname !== '/api/ws' ? 'unknown path' : `origin ${req.headers.origin}`}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')

    return
  }

  backendUrl(url.searchParams.get('backend')).then(target => {
    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')

      return
    }

    wss.handleUpgrade(req, socket, head, client => bridge(client, target))
  })
})

function openBackend(url, force) {
  return backendToken(url, force).then(
    value =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(value)}`, {
          maxPayload: MAX_FRAME
        })

        ws.once('open', () => resolve(ws))
        ws.once('unexpected-response', (_req, response) =>
          reject(Object.assign(new Error(`backend refused (${response.statusCode})`), { status: response.statusCode }))
        )
        ws.once('error', reject)
      })
  )
}

async function bridge(client, url) {
  // Frames the phone sends before the backend socket opens are held, then flushed in order.
  const early = []
  let backend = null
  let closed = false

  const onEarly = (data, isBinary) => early.push([data, isBinary])
  client.on('message', onEarly)
  // From the first moment: an unhandled 'error' on either socket would end the whole server.
  client.on('error', error => log('phone websocket error:', error.message))

  const shut = (code, reason) => {
    if (closed) {
      return
    }

    closed = true

    for (const ws of [client, backend]) {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close(code, reason)
      }
    }
  }

  client.on('close', () => shut(1000, 'phone closed'))

  // A phone that vanished without closing (dead radio, killed app) must stop counting as a client
  // of its chats, or Hermes keeps waiting on it for answers: ping both legs, drop what stops answering.
  const alive = new Map()
  const keepalive = setInterval(() => {
    for (const ws of [client, backend]) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue
      }

      if (alive.get(ws) === false) {
        shut(1001, 'connection lost')

        return
      }

      alive.set(ws, false)
      ws.ping()
    }
  }, 20_000)
  client.on('pong', () => alive.set(client, true))
  client.on('close', () => clearInterval(keepalive))

  try {
    try {
      backend = await openBackend(url, false)
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) {
        throw error
      }

      backend = await openBackend(url, true)
    }
  } catch (error) {
    log('backend websocket failed:', error.message)
    shut(1013, 'Hermes backend unavailable')

    return
  }

  if (closed) {
    backend.close()

    return
  }

  client.off('message', onEarly)

  for (const [data, isBinary] of early) {
    backend.send(data, { binary: isBinary })
  }

  client.on('message', (data, isBinary) => backend.readyState === WebSocket.OPEN && backend.send(data, { binary: isBinary }))
  backend.on('message', (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }))
  backend.on('close', (code, reason) => shut(code === 1005 || code === 1006 ? 1011 : code, reason.toString()))
  backend.on('error', error => log('backend websocket error:', error.message))
  backend.on('pong', () => alive.set(backend, true))
  backend.on('close', () => clearInterval(keepalive))
}

// ---------------------------------------------------------------- start

if (!config.origin || !config.logins.length || !config.devices.length) {
  log('HM_PUBLIC_ORIGIN, HM_ALLOWED_LOGINS and HM_ALLOWED_DEVICES are not all set (see .env.example): every request will be refused')
}

await refreshAllowedIps()
setInterval(refreshAllowedIps, 60_000).unref()

if (config.socket) {
  await mkdir(path.dirname(config.socket), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(config.socket), 0o700)
  await rm(config.socket, { force: true })
  server.listen(config.socket, () => {
    void chmod(config.socket, 0o600)
    log(`Hermes Mobile on unix:${config.socket} -> ${config.backend}; devices: ${config.devices.join(', ')}`)
  })
} else {
  server.listen(config.port, config.host, () => {
    log(`Hermes Mobile on http://${config.host}:${config.port} -> ${config.backend}; devices: ${config.devices.join(', ')}`)
  })
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const ws of wss.clients) {
      ws.close(1012, 'server restarting')
    }

    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
