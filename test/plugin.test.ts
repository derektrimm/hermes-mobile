import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugin')

// Loads the plugin the way Hermes does (register(ctx), then hooks with Hermes's keyword arguments)
// and waits for its delivery thread to empty the queue.
const DRIVER = `
import sys, time
sys.path.insert(0, sys.argv[1])
import hermes_mobile_push as plugin

class Ctx:
    profile_name = "claude2"
    def __init__(self): self.hooks = {}
    def register_hook(self, name, fn): self.hooks[name] = fn

ctx = Ctx()
plugin.register(ctx)
h = ctx.hooks
h["pre_llm_call"](session_id="s1", task_id="t", turn_id="turn1", user_message="hi", conversation_history=[], is_first_turn=True, model="m", platform="tui", parent_session_id="", sender_id="")
h["on_human_input_request"](kind="approval", request_id="r1", session_id="s1", session_key="k", platform="tui", prompt="rm -rf build", password="never-forwarded")
h["on_human_input_resolved"](kind="approval", request_id="r1", session_id="s1", session_key="k", platform="tui", prompt="rm -rf build", outcome="approved")
h["post_llm_call"](session_id="s1", task_id="t", turn_id="turn1", user_message="hi", assistant_response="x" * 5000, conversation_history=[], model="m", platform="tui")
h["on_session_end"](session_id="s1", task_id="t", turn_id="turn1", completed=True, failed=False, interrupted=False, model="m", platform="tui")
h["on_session_end"](session_id="s1", platform="tui")
h["subagent_start"](parent_session_id="s1", parent_turn_id="turn1", child_session_id="c1", child_role=None)
h["subagent_stop"](parent_session_id="s1", parent_turn_id="turn1", child_session_id="c1", child_role=None, child_summary="Indexed", child_status="completed", tool_call_history=[{"secret": "x"}], duration_ms=5)
deadline = time.time() + 10
while not plugin._queue.empty() and time.time() < deadline:
    time.sleep(0.05)
time.sleep(0.3)
`

function runDriver(socket: string | null) {
  return new Promise<void>((resolve, reject) => {
    const env = { ...process.env, HERMES_HOME: '/home/someone/.hermes/profiles/claude2' }

    if (socket) {
      env.HERMES_MOBILE_EVENTS = socket
    } else {
      env.HERMES_MOBILE_EVENTS = '/nonexistent/events.sock'
    }

    execFile('python3', ['-I', '-c', DRIVER, plugin], { env, timeout: 20_000 }, (error, _stdout, stderr) =>
      error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()
    )
  })
}

test('the plugin forwards each hook as one small event, in order, and nothing a person typed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hm-plugin-'))
  const socket = path.join(dir, 'events.sock')
  const received: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/event')
      received.push(JSON.parse(body))
      res.writeHead(204).end()
    })
  })

  try {
    await new Promise<void>(resolve => server.listen(socket, resolve))
    await runDriver(socket)

    assert.deepEqual(
      received.map(e => e.event),
      ['turn_start', 'input', 'input_resolved', 'reply', 'turn_end', 'turn_end', 'subagent_start', 'task_end']
    )

    for (const event of received) {
      assert.equal(event.v, 1)
      assert.equal(event.profile, 'claude2')
      assert.equal(event.home, '/home/someone/.hermes/profiles/claude2')
      assert.equal(typeof event.pid, 'number')
    }

    const [start, input, , reply, ended, closed, , task] = received
    assert.deepEqual(
      { session_id: start.session_id, turn_id: start.turn_id, platform: start.platform },
      { session_id: 's1', turn_id: 'turn1', platform: 'tui' }
    )
    assert.equal(start.parent_session_id, undefined, 'empty values are left out')
    assert.equal(input.prompt, 'rm -rf build')
    assert.ok(!JSON.stringify(received).includes('never-forwarded'))
    assert.ok(!JSON.stringify(received).includes('secret'))
    assert.equal((reply.text as string).length, 4000)
    assert.deepEqual([ended.completed, ended.failed, ended.interrupted], [true, false, false])
    assert.ok(!('completed' in closed) && !('failed' in closed), 'a closing session claims no verdict')
    assert.deepEqual([task.parent_session_id, task.child_session_id, task.child_status, task.summary], ['s1', 'c1', 'completed', 'Indexed'])
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('with the server down nothing fails or hangs', async () => {
  const started = Date.now()
  await runDriver(null)
  assert.ok(Date.now() - started < 8000)
})
