import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mediaUrl, splitMedia } from '../src/lib/media.ts'

test('delivery tags leave the text and become files, in order, once each', () => {
  const { text, media } = splitMedia(
    'Here are the three:\n\nMEDIA:/home/derek/.hermes/cache/scratch/grokimg.kcNC/barn.png\nMEDIA:/home/derek/.hermes/cache/scratch/grokimg.kcNC/beach.mp4\n`MEDIA:/tmp/report final.pdf`\nMEDIA:/home/derek/.hermes/cache/scratch/grokimg.kcNC/barn.png\n\nEnjoy.'
  )

  assert.equal(text, 'Here are the three:\n\nEnjoy.')
  assert.deepEqual(
    media.map(m => [m.name, m.kind, m.viewable]),
    [
      ['barn.png', 'image', true],
      ['beach.mp4', 'video', true],
      ['report final.pdf', 'file', true]
    ]
  )
})

test('a tag inside a sentence leaves the sentence, and trailing punctuation is not the path', () => {
  const { text, media } = splitMedia('Saved it as MEDIA:/tmp/plot.png, open it when you can.')

  assert.equal(text, 'Saved it as, open it when you can.')
  assert.equal(media[0].path, '/tmp/plot.png')
})

test('local Markdown images become files; web images stay in the text', () => {
  const { text, media } = splitMedia('![chart](/srv/out/chart.webp) and ![logo](https://example.com/logo.png)')

  assert.equal(text, 'and ![logo](https://example.com/logo.png)')
  assert.deepEqual(media.map(m => m.path), ['/srv/out/chart.webp'])
})

test('examples in code are left alone', () => {
  const sample = 'Write it like this:\n\n```\nMEDIA:/tmp/example.png\n```\n\nor inline: `MEDIA:/tmp/x.png` in prose `see MEDIA:/tmp/y.png`'
  const { text, media } = splitMedia(sample)

  assert.deepEqual(media.map(m => m.path), ['/tmp/x.png'])
  assert.ok(text.includes('```\nMEDIA:/tmp/example.png\n```'))
  assert.ok(text.includes('`see MEDIA:/tmp/y.png`'))
})

test('files the phone may not open still show by name', () => {
  const { media } = splitMedia('MEDIA:/home/derek/.ssh/id_ed25519.png\nMEDIA:/home/derek/src/site/index.html\nMEDIA:/home/derek/notes.docx')

  assert.deepEqual(
    media.map(m => [m.name, m.viewable]),
    [
      ['id_ed25519.png', false],
      ['index.html', false],
      ['notes.docx', false]
    ]
  )
})

test('text with nothing to deliver is returned as it was', () => {
  const plain = 'No files here.\n\n- one\n- two'
  assert.equal(splitMedia(plain).text, plain)
  assert.equal(splitMedia('Ratio is 3/4. MEDIA: is how Hermes delivers files.').media.length, 0)
})

test('while a reply streams, a tag on its unfinished last line stays text', () => {
  const streaming = splitMedia('Done:\nMEDIA:/tmp/plot.png\nMEDIA:/tmp/pl', true)

  assert.deepEqual(streaming.media.map(m => m.path), ['/tmp/plot.png'])
  assert.equal(streaming.text, 'Done:\nMEDIA:/tmp/pl')
  assert.deepEqual(splitMedia('MEDIA:/tmp/pl', true), { text: 'MEDIA:/tmp/pl', media: [], parts: [{ kind: 'text', text: 'MEDIA:/tmp/pl' }] })
  assert.deepEqual(
    streaming.parts.map(p => p.kind),
    ['text', 'media', 'text']
  )
})

test('files show where the reply puts them: on their own line there, inside a sentence after its paragraph', () => {
  const { parts } = splitMedia(
    'Here is your chart:\n\nMEDIA:/tmp/chart.png\nMEDIA:/tmp/table.csv\n\nI also saved MEDIA:/tmp/raw.mp4 for you.\nSee above.\n\nAll set.'
  )

  assert.deepEqual(
    parts.map(p => (p.kind === 'text' ? p.text : p.media.map(m => m.name).join(','))),
    ['Here is your chart:', 'chart.png,table.csv', 'I also saved for you.\nSee above.', 'raw.mp4', 'All set.']
  )
})

test('files are read through the chat backend', () => {
  assert.equal(
    mediaUrl({ path: '/tmp/a b.png', name: 'a b.png', kind: 'image', viewable: true }, { backend: 'pc-123', profile: 'claude2' }),
    '/hm/file?path=%2Ftmp%2Fa+b.png&profile=claude2&backend=pc-123'
  )
})
