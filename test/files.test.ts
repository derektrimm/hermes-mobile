import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fileAllowed, fileType } from '../server/files.mjs'

test('files a reply names: media and documents, anywhere ordinary', () => {
  for (const ok of [
    '/home/derek/.hermes/cache/scratch/grokimg.kcNC/barn.png',
    '/home/derek/.hermes/images/a.webp',
    '/home/derek/.hermes/profiles/claude2/screenshots/shot.PNG',
    '~/.hermes/cache/beach.mp4',
    '/tmp/plot.png',
    '/home/derek/src/app/docs/report.pdf',
    '~/Videos/trailer final.mov',
    '/srv/data/table.csv'
  ]) {
    assert.ok(fileAllowed(ok), ok)
  }
})

test('never secrets, hidden folders, other types or tricks', () => {
  for (const bad of [
    '/home/derek/.ssh/id_ed25519',
    '/home/derek/.ssh/id_ed25519.png',
    '/home/derek/.config/gh/hosts.png',
    '/home/derek/.claude/.credentials.json',
    '/home/derek/.hermes/auth.json',
    '/home/derek/.hermes/state.db',
    '/home/derek/.hermes/config.png',
    '/home/derek/.hermes/profiles/claude2/auth.png',
    '/home/derek/.hermes/profiles/.hidden/images/a.png',
    '/home/derek/.hermes/cache/../../.ssh/key.png',
    '/home/derek/./.ssh/key.png',
    '/home/derek/.env.png',
    '/home/derek/src/app/.env',
    '/home/derek/src/app/page.html',
    '/home/derek/src/app/logo.svg',
    '/home/derek/notes.json',
    'relative/plot.png',
    'C:/Users/x/plot.png',
    '/tmp/a.png\0.txt',
    `/${'a/'.repeat(3000)}x.png`
  ]) {
    assert.ok(!fileAllowed(bad), bad)
  }
})

test('the served type comes from the extension, text never as HTML', () => {
  assert.equal(fileType('/a/b.JPG'), 'image/jpeg')
  assert.equal(fileType('/a/b.md'), 'text/plain; charset=utf-8')
  assert.equal(fileType('/a/b.html'), null)
  assert.equal(fileType('/a/b'), null)
})
