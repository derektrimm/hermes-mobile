import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compactionReply, fromStored, fromTranscript } from '../src/lib/transcript.ts'

test('gateway transcript keeps user, answer, reasoning and tool rows in order', () => {
  const items = fromTranscript([
    { role: 'user', text: 'run it', row_id: 1 },
    { role: 'assistant', text: '', reasoning: 'thinking about it', row_id: 2 },
    { role: 'tool', name: 'terminal', context: 'echo hi', tool_call_id: 'a' },
    { role: 'assistant', text: 'done', row_id: 3 }
  ])

  assert.deepEqual(
    items.map(i => i.kind),
    ['user', 'assistant', 'tool', 'assistant']
  )
  assert.equal(items[2].kind === 'tool' && items[2].context, 'echo hi')
})

test('hidden rows are dropped and bookkeeping rows become notices', () => {
  const items = fromTranscript([
    { role: 'user', text: 'secret nudge', display_kind: 'hidden' },
    { role: 'user', text: '', display_kind: 'auto_continue' },
    { role: 'user', text: 'Switched to Opus', display_kind: 'model_switch' }
  ])

  assert.deepEqual(
    items.map(i => [i.kind, 'text' in i ? i.text : '']),
    [
      ['notice', 'Hermes continued on its own'],
      ['notice', 'Switched to Opus']
    ]
  )
})

test('a merged compaction row keeps the reply and folds the summary into a note', () => {
  const text =
    '[PRIOR CONTEXT — for reference only; not a new message]\nTesting the index first.\n\n' +
    '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns...'

  assert.deepEqual(compactionReply(text), { reply: 'Testing the index first.' })
  assert.equal(compactionReply('[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted')?.reply, '')
  assert.equal(compactionReply('[terminal] ran ls'), null)

  const items = fromStored([{ id: 7, role: 'assistant', content: text, tool_calls: [{ id: 't1', function: { name: 'terminal', arguments: '{"command":"ls"}' } }] }])
  assert.deepEqual(
    items.map(i => i.kind),
    ['assistant', 'notice', 'tool']
  )
})

test('stored rows pair tool calls with their results; unanswered calls stay running', () => {
  const items = fromStored([
    { id: 1, role: 'user', content: 'go' },
    {
      id: 2,
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'x', function: { name: 'terminal', arguments: '{"command":"uptime"}' } },
        { id: 'y', function: { name: 'read_file', arguments: '{"path":"/etc/hostname"}' } }
      ]
    },
    { id: 3, role: 'tool', tool_call_id: 'x', content: '{"output":"up 3 days","exit_code":0}' }
  ])

  const tools = items.filter(i => i.kind === 'tool')
  assert.equal(tools.length, 2)
  assert.deepEqual(
    tools.map(t => t.kind === 'tool' && [t.context, t.status, t.output ?? null]),
    [
      ['uptime', 'done', 'up 3 days'],
      ['/etc/hostname', 'running', null]
    ]
  )
})
