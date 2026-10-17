import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  encrypt,
  fromB64u,
  isSilent,
  loadVapid,
  notificationBody,
  Notifier,
  plainText,
  PushStore,
  pushEndpointAllowed,
  QUICK_TURN_MS,
  REPLY_GRACE_MS,
  vapidAuthorization
} from '../server/push.mjs'

// RFC 8291, section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

/** What the phone does with a message: the receiving half of RFC 8291. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer) {
  const salt = body.subarray(0, 16)
  const idLength = body[20]
  const asPublic = body.subarray(21, 21 + idLength)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const shared = ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const record = body.subarray(21 + idLength)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(record.length - 16))
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()])
  assert.equal(plain[plain.length - 1], 2, 'last record ends with the 0x02 delimiter')

  return plain.subarray(0, plain.length - 1).toString()
}

test('encryption reproduces the RFC 8291 example exactly', () => {
  const body = encrypt({ p256dh: RFC.uaPublic, auth: RFC.auth }, RFC.plaintext, {
    salt: fromB64u(RFC.salt),
    senderPrivate: fromB64u(RFC.asPrivate)
  })

  assert.equal(body.toString('base64url'), RFC.body)
  assert.equal(decrypt(body, fromB64u(RFC.uaPrivate), fromB64u(RFC.auth)), RFC.plaintext)
})

test('a message encrypted with fresh keys opens with the phone keys and nothing else', () => {
  const phone = createECDH('prime256v1')
  phone.generateKeys()
  const auth = randomBytes(16)
  const keys = { p256dh: phone.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
  const message = JSON.stringify({ title: 'Release notes', body: 'Done: 3 files changed' })
  const body = encrypt(keys, message)

  assert.equal(decrypt(body, phone.getPrivateKey(), auth), message)
  assert.notEqual(encrypt(keys, message).toString('hex'), body.toString('hex'), 'every message has its own salt and key')

  const stranger = createECDH('prime256v1')
  stranger.generateKeys()
  assert.throws(() => decrypt(body, stranger.getPrivateKey(), auth))
  assert.throws(() => decrypt(body, phone.getPrivateKey(), randomBytes(16)))
})

test('bad subscription keys and oversized payloads are refused', () => {
  const phone = createECDH('prime256v1')
  phone.generateKeys()
  const keys = { p256dh: phone.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }

  assert.throws(() => encrypt({ ...keys, p256dh: 'AAAA' }, 'x'), /p256dh/)
  assert.throws(() => encrypt({ ...keys, auth: randomBytes(8).toString('base64url') }, 'x'), /auth/)
  assert.throws(() => encrypt(keys, 'x'.repeat(4080)), /too large/)
  assert.doesNotThrow(() => encrypt(keys, 'x'.repeat(4079)))
})

test('the server identity is made once, kept owner-only, and signs a token the push service can check', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-push-'))

  try {
    const file = path.join(dir, 'state', 'vapid.json')
    const vapid = await loadVapid(file)
    const again = await loadVapid(file)

    assert.equal(again.publicKey, vapid.publicKey)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal(fromB64u(vapid.publicKey).length, 65)

    const now = Date.UTC(2026, 9, 16, 12)
    const header = vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH2LS7Ow', vapid, 'https://hermes.example.ts.net:8620', now)
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
    assert.ok(match, header)
    const [, head, claims, signature, k] = match
    assert.equal(k, vapid.publicKey)
    assert.deepEqual(JSON.parse(fromB64u(head).toString()), { typ: 'JWT', alg: 'ES256' })
    assert.deepEqual(JSON.parse(fromB64u(claims).toString()), {
      aud: 'https://web.push.apple.com',
      exp: now / 1000 + 3600,
      sub: 'https://hermes.example.ts.net:8620'
    })

    const raw = fromB64u(vapid.publicKey)
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
      format: 'jwk'
    })
    assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, fromB64u(signature)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('subscriptions keep their preferences across a re-registration and are owner-only on disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-push-'))

  try {
    const file = path.join(dir, 'push.json')
    const store = new PushStore(file)
    const keys = { p256dh: 'p', auth: 'a' }
    await store.put({ endpoint: 'https://web.push.apple.com/one', keys, device: '100.1.1.1', prefs: { replies: false, bogus: true } })
    await store.put({ endpoint: 'https://web.push.apple.com/one', keys, device: '100.1.1.1' })

    const fresh = new PushStore(file)
    assert.equal((await fresh.all()).length, 1)
    assert.deepEqual((await fresh.get('https://web.push.apple.com/one'))?.prefs, { needs: true, replies: false, failures: true, tasks: true })
    assert.equal((await stat(file)).mode & 0o777, 0o600)

    await fresh.setPrefs('https://web.push.apple.com/one', { tasks: false, replies: 'yes' })
    assert.deepEqual((await fresh.get('https://web.push.apple.com/one'))?.prefs, { needs: true, replies: false, failures: true, tasks: false })
    await fresh.remove('https://web.push.apple.com/one')
    assert.equal((await new PushStore(file).all()).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('only real push services are ever posted to', () => {
  for (const ok of ['https://web.push.apple.com/abc', 'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc']) {
    assert.ok(pushEndpointAllowed(ok), ok)
  }

  for (const bad of ['http://web.push.apple.com/abc', 'https://127.0.0.1:9119/api', 'https://web.push.apple.com.evil.example/x', 'https://web.push.apple.com:8443/x', 'not a url']) {
    assert.ok(!pushEndpointAllowed(bad), bad)
  }
})

test('replies read as words, not markup', () => {
  assert.equal(
    plainText('## Done\n\n- **3** files changed in [the repo](https://x.y)\n- `npm test` passes\n\n```sh\nnpm run build\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |'),
    'Done\n\n• 3 files changed in the repo\n• npm test passes\n\nnpm run build\n\na · b\n1 · 2'
  )
  assert.ok(isSilent('[SILENT]'))
  assert.ok(isSilent('  [silent] '))
  assert.ok(isSilent(''))
  assert.ok(!isSilent('[SILENT] but here is why'))
  assert.equal(notificationBody('needs', { inputKind: 'approval', prompt: 'rm -rf build' }), 'Wants to run: rm -rf build')
  assert.equal(notificationBody('needs', { inputKind: 'clarify', prompt: 'Which branch?' }), 'Asks: Which branch?')
  assert.equal(notificationBody('needs', { inputKind: 'sudo', prompt: 'pacman -Syu' }), 'Needs your sudo password')
  assert.equal(notificationBody('tasks', { summary: 'Indexed **42** files', status: 'completed' }), 'Task finished: Indexed 42 files')
  assert.ok(notificationBody('replies', { text: 'word '.repeat(200) }).length <= 300)
})

// ---------------------------------------------------------------- the notifier

function harness({ viewing = () => false, held = false } = {}) {
  let clock = 1_000_000
  const timers: Array<{ at: number; run: () => void; id: number }> = []
  let ids = 0
  const sent: Array<{ kind: string; detail: Record<string, unknown> }> = []
  const notifier = new Notifier({
    notify: async (kind: string, detail: Record<string, unknown>) => {
      sent.push({ kind, detail })
    },
    viewing,
    heldOnPc: async () => held,
    now: () => clock,
    later: (run: () => void, ms: number) => {
      const timer = { at: clock + ms, run, id: ++ids }
      timers.push(timer)

      return timer.id
    },
    cancel: (id: number) => {
      const index = timers.findIndex(t => t.id === id)

      if (index >= 0) {
        timers.splice(index, 1)
      }
    }
  })

  const advance = async (ms: number) => {
    clock += ms

    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= clock) {
        timers.splice(timers.indexOf(timer), 1)
        timer.run()
      }
    }

    await flush()
  }

  const flush = () => new Promise(resolve => setTimeout(resolve, 5))
  const event = async (e: Record<string, unknown>) => {
    notifier.handle({ profile: 'claude2', platform: 'tui', ...e })
    await flush()
  }

  return { notifier, sent, advance, event, flush, timers }
}

test('a reply goes out once the turn ends, after Hermes says it completed', async () => {
  const h = harness()
  await h.event({ event: 'turn_start', session_id: 's1', turn_id: 't1' })
  await h.event({ event: 'reply', session_id: 's1', turn_id: 't1', text: 'All **done**.' })
  assert.equal(h.sent.length, 0, 'held until the verdict')
  await h.event({ event: 'turn_end', session_id: 's1', turn_id: 't1', completed: true, failed: false, interrupted: false })
  assert.deepEqual(h.sent, [{ kind: 'replies', detail: { session: 's1', profile: 'claude2', text: 'All **done**.' } }])
  await h.advance(REPLY_GRACE_MS * 2)
  assert.equal(h.sent.length, 1, 'never twice')
})

test('a failed turn sends only its failure, a stopped one sends nothing, a silent one nothing', async () => {
  const h = harness()
  await h.event({ event: 'turn_start', session_id: 's1', turn_id: 't1' })
  await h.event({ event: 'reply', session_id: 's1', turn_id: 't1', text: 'Error: provider returned 500' })
  await h.event({ event: 'turn_end', session_id: 's1', turn_id: 't1', completed: false, failed: true, interrupted: false })
  assert.deepEqual(h.sent.map(s => s.kind), ['failures'])

  await h.event({ event: 'turn_start', session_id: 's1', turn_id: 't2' })
  await h.event({ event: 'reply', session_id: 's1', turn_id: 't2', text: 'partial' })
  await h.event({ event: 'turn_end', session_id: 's1', turn_id: 't2', interrupted: true })
  await h.event({ event: 'turn_start', session_id: 's1', turn_id: 't3' })
  await h.event({ event: 'reply', session_id: 's1', turn_id: 't3', text: '[SILENT]' })
  await h.event({ event: 'turn_end', session_id: 's1', turn_id: 't3', completed: true })
  await h.advance(REPLY_GRACE_MS * 2)
  assert.deepEqual(h.sent.map(s => s.kind), ['failures'])
})

test('a turn that hit its step limit still answers, and a Hermes that never says goes out after the grace', async () => {
  const h = harness()
  await h.event({ event: 'turn_start', session_id: 's1', turn_id: 't1' })
  await h.event({ event: 'reply', session_id: 's1', turn_id: 't1', text: 'Stopped at the step limit; here is where I got.' })
  await h.event({ event: 'turn_end', session_id: 's1', turn_id: 't1', completed: false, failed: false, interrupted: false })
  assert.deepEqual(h.sent.map(s => s.kind), ['replies'])

  await h.event({ event: 'turn_start', session_id: 's2', turn_id: 'u1' })
  await h.event({ event: 'reply', session_id: 's2', turn_id: 'u1', text: 'Here.' })
  await h.advance(REPLY_GRACE_MS - 1)
  assert.equal(h.sent.length, 1)
  await h.advance(1)
  assert.deepEqual(h.sent.map(s => s.detail.session), ['s1', 's2'])
})

test('nothing for chats on screen, subagents, messaging platforms or editors', async () => {
  const h = harness({ viewing: (session: string) => session === 'watched' })
  const turn = async (session: string, extra: Record<string, unknown> = {}) => {
    await h.event({ event: 'turn_start', session_id: session, turn_id: 't', ...extra })
    await h.event({ event: 'reply', session_id: session, turn_id: 't', text: 'hi', ...extra })
    await h.event({ event: 'turn_end', session_id: session, turn_id: 't', completed: true, ...extra })
  }
  await turn('watched')
  await turn('child', { parent_session_id: 'parent' })
  await turn('discord-thread', { platform: 'discord' })
  await turn('t3-thread', { platform: 'acp' })
  await turn('desktop-chat', { platform: 'desktop' })
  await turn('terminal', { platform: 'cli' })
  assert.deepEqual(h.sent.map(s => s.detail.session), ['desktop-chat', 'terminal'])
})

test('a quick reply to a turn typed on the PC stays quiet; a long one or one the phone sent notifies', async () => {
  const h = harness({ held: true })
  await h.event({ event: 'turn_start', session_id: 'pc', turn_id: 't1' })
  await h.advance(QUICK_TURN_MS - 1000)
  await h.event({ event: 'reply', session_id: 'pc', turn_id: 't1', text: 'quick' })
  await h.event({ event: 'turn_end', session_id: 'pc', turn_id: 't1', completed: true })
  assert.equal(h.sent.length, 0)

  await h.event({ event: 'turn_start', session_id: 'pc', turn_id: 't2' })
  await h.advance(QUICK_TURN_MS + 1000)
  await h.event({ event: 'reply', session_id: 'pc', turn_id: 't2', text: 'slow' })
  await h.event({ event: 'turn_end', session_id: 'pc', turn_id: 't2', completed: true })
  assert.deepEqual(h.sent.map(s => s.detail.text), ['slow'])

  h.notifier.notePhoneSent('pc')
  await h.event({ event: 'turn_start', session_id: 'pc', turn_id: 't3' })
  await h.event({ event: 'reply', session_id: 'pc', turn_id: 't3', text: 'for the phone' })
  await h.event({ event: 'turn_end', session_id: 'pc', turn_id: 't3', completed: true })
  assert.deepEqual(h.sent.map(s => s.detail.text), ['slow', 'for the phone'])
})

test('a question notifies at once, or, early in a turn typed on the PC, only if still unanswered later', async () => {
  const away = harness()
  await away.event({ event: 'turn_start', session_id: 's1', turn_id: 't1' })
  await away.event({ event: 'input', session_id: 's1', kind: 'clarify', request_id: 'r1', prompt: 'Which branch?' })
  assert.deepEqual(away.sent, [{ kind: 'needs', detail: { session: 's1', profile: 'claude2', inputKind: 'clarify', prompt: 'Which branch?' } }])
  await away.event({ event: 'input', session_id: 's1', kind: 'clarify', request_id: 'r1', prompt: 'Which branch?' })
  assert.equal(away.sent.length, 1, 'one request, one notification')

  const atPc = harness({ held: true })
  await atPc.event({ event: 'turn_start', session_id: 'pc', turn_id: 't1' })
  await atPc.event({ event: 'input', session_id: 'pc', kind: 'approval', request_id: 'answered', prompt: 'git push' })
  await atPc.advance(10_000)
  await atPc.event({ event: 'input_resolved', session_id: 'pc', request_id: 'answered', outcome: 'approved' })
  await atPc.event({ event: 'input', session_id: 'pc', kind: 'approval', request_id: 'waiting', prompt: 'git push --tags' })
  await atPc.advance(QUICK_TURN_MS)
  assert.deepEqual(atPc.sent.map(s => s.detail.prompt), ['git push --tags'])
  assert.equal(atPc.timers.length, 0)
})

test('a background task that outlives its turn notifies; one inside the turn is part of the reply', async () => {
  const h = harness()
  await h.event({ event: 'turn_start', session_id: 'p', turn_id: 't1' })
  await h.event({ event: 'subagent_start', parent_session_id: 'p', parent_turn_id: 't1', child_session_id: 'c1' })
  await h.event({ event: 'turn_start', session_id: 'c1', turn_id: 'x', parent_session_id: 'p', platform: 'subagent' })
  await h.event({ event: 'task_end', parent_session_id: 'p', parent_turn_id: 't1', child_session_id: 'c1', child_status: 'completed', summary: 'inline' })
  await h.event({ event: 'subagent_start', parent_session_id: 'p', parent_turn_id: 't1', child_session_id: 'c2' })
  await h.event({ event: 'reply', session_id: 'p', turn_id: 't1', text: 'Started the index in the background.' })
  await h.event({ event: 'turn_end', session_id: 'p', turn_id: 't1', completed: true })
  await h.event({ event: 'task_end', parent_session_id: 'p', parent_turn_id: 't1', child_session_id: 'c2', child_status: 'completed', summary: 'Indexed 42 files' })
  assert.deepEqual(
    h.sent.map(s => [s.kind, s.detail.text ?? s.detail.summary]),
    [
      ['replies', 'Started the index in the background.'],
      ['tasks', 'Indexed 42 files']
    ]
  )
})
