import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { Marked, type Tokens } from 'marked'

import { copyText } from './clipboard'

for (const [name, lang] of Object.entries({ bash, css, diff, go, javascript, json, python, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, lang)
}

const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  fish: 'bash',
  console: 'bash',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  yml: 'yaml',
  html: 'xml',
  svg: 'xml',
  patch: 'diff',
  rs: 'rust'
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const raw = (lang || '').trim().split(/\s/)[0].toLowerCase()
      const language = ALIASES[raw] || raw
      const body = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escape(text)
      const label = raw || 'text'

      return (
        `<div class="code"><div class="code-bar"><span>${escape(label)}</span>` +
        `<button type="button" class="code-copy" data-copy>Copy</button></div>` +
        `<pre><code class="hljs">${body}</code></pre></div>`
      )
    }
  }
})

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string

  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-copy'] })
}

/** Copy-button handler for rendered code blocks (event delegation on the message). */
export function handleCopyClick(event: MouseEvent | React.MouseEvent) {
  const button = (event.target as HTMLElement).closest('[data-copy]') as HTMLButtonElement | null

  if (!button) {
    return
  }

  const code = button.closest('.code')?.querySelector('code')?.textContent ?? ''
  void copyText(code).then(ok => {
    if (ok) {
      button.textContent = 'Copied'
      setTimeout(() => (button.textContent = 'Copy'), 1500)
    }
  })
}
