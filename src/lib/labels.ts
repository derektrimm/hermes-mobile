// One vocabulary for accounts, providers, models and reasoning effort, so every surface (header,
// sheets, pickers) names the same thing the same way: "Claude 2 · Opus 5.5 · High".

// ---------------------------------------------------------------- effort

/** Hermes's reasoning ladder, weakest first (apps/shared reasoning-effort.ts, same order). */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type Effort = (typeof EFFORTS)[number] | 'none'

const EFFORT_NAMES: Record<string, { label: string; hint: string }> = {
  none: { label: 'Off', hint: 'Answers without reasoning first' },
  minimal: { label: 'Minimal', hint: 'Quickest answers' },
  low: { label: 'Low', hint: 'Light reasoning' },
  medium: { label: 'Medium', hint: 'Balanced speed and depth' },
  high: { label: 'High', hint: 'Thinks problems through' },
  xhigh: { label: 'Extra High', hint: 'Deeper reasoning for hard problems' },
  max: { label: 'Max', hint: 'The most the model can reason' },
  ultra: { label: 'Ultra', hint: 'Beyond Max where the model allows it' }
}

export function effortLabel(effort?: string | null): string {
  const key = (effort || '').trim().toLowerCase()

  return EFFORT_NAMES[key]?.label ?? ''
}

export function effortHint(effort: string): string {
  return EFFORT_NAMES[effort]?.hint ?? ''
}

// ---------------------------------------------------------------- providers

const PROVIDERS: Record<string, string> = {
  anthropic: 'Anthropic API',
  'openai-codex': 'ChatGPT Subscription',
  openai: 'OpenAI API',
  copilot: 'GitHub Copilot',
  xai: 'xAI API',
  'grok-acp': 'Grok Subscription',
  venice: 'Venice',
  openrouter: 'OpenRouter',
  nous: 'Nous Portal'
}

/** A provider's name: known slugs by name; a custom Claude login ("Claude (claude2, ...)") as its account. */
export function providerLabel(slug: string, name?: string | null): string {
  if (PROVIDERS[slug]) {
    return PROVIDERS[slug]
  }

  const login = (name || '').match(/^claude\s*\(\s*claude(\d+)/i) ?? slug.match(/^claude(\d+)$/i)

  if (login) {
    return `Claude ${login[1]} Subscription`
  }

  // Drop parenthesised account details and any "Subscription"-style casing drift.
  return titleWords((name || slug).replace(/\s*\(.*?\)\s*/g, ' ').trim())
}

// ---------------------------------------------------------------- models

const WORDS: Record<string, string> = {
  gpt: 'GPT',
  glm: 'GLM',
  ai: 'AI',
  api: 'API',
  xai: 'xAI',
  '4o': '4o',
  v: 'V'
}

const titleWord = (word: string) =>
  WORDS[word.toLowerCase()] ??
  (/^(\d+(\.\d+)?|[a-z]\d+)[kmbt]$/i.test(word)
    ? word.toUpperCase() // 900k -> 900K, 27b -> 27B, a95b -> A95B
    : /^\d/.test(word)
      ? word.replace(/[a-z]+$/i, letters => letters.toUpperCase()) // 5v -> 5V
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())

const titleWords = (text: string) => text.split(/\s+/).filter(Boolean).map(titleWord).join(' ')

/** Vendor namespaces some routers prefix to a model id (Venice: "zai-org-glm-5-2"). */
const NAMESPACE = /^(?:z-ai|zai-org|olafangensan)-/i

/**
 * A model's display name from its id: "claude-opus-5-5" -> "Opus 5.5", "gpt-6-astra-900k" ->
 * "GPT-6 Astra 900K", "grok-4.20-0309-reasoning" -> "Grok 4.20 Reasoning", "zai-org-glm-5-2" -> "GLM 5.2".
 */
export function modelLabel(id?: string | null): string {
  if (!id) {
    return ''
  }

  // A context-window variant ("claude-opus-5-5[1m]") is a different choice: keep it visible.
  const window = id.trim().match(/\[(\d+(?:\.\d+)?[kmb])\]$/i)?.[1].toUpperCase()
  const suffix = window ? ` ${window}` : ''
  let raw = id.trim().toLowerCase().replace(/\[.*?\]$/, '').replace(NAMESPACE, '')

  // Claude: the family name is the model's name, as on claude.ai.
  const claude = raw.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?(?:-(\d{8}))?$/)

  if (claude) {
    return `${titleWord(claude[1])} ${claude[2]}${claude[3] && claude[3].length < 3 ? `.${claude[3]}` : ''}${suffix}`
  }

  // Dates and date-like build stamps say nothing a person picks by.
  raw = raw.replace(/-(\d{8}|\d{4})(?=-|$)/g, '')

  const parts = raw.split('-')
  const out: string[] = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const prev = out[out.length - 1]

    // Version pieces split by dashes join with a dot: "3-8" -> "3.8", "2-4t" -> "2.4t".
    if (/^\d+[kmbt]?$/i.test(part) && prev && /^\d+$/.test(prev)) {
      out[out.length - 1] = `${prev}.${part}`
      continue
    }

    // Compounds keep their hyphen: "non-reasoning", "multi-agent", "role-play".
    if (prev && /^(non|multi|role)$/i.test(prev)) {
      out[out.length - 1] = `${titleWord(prev)}-${titleWord(part)}`
      continue
    }

    out.push(part)
  }

  const words = out.map(word => (word.includes('-') ? word : titleWord(word)))

  // OpenAI writes its versions onto the name: "GPT-6", "GPT-4o".
  if (words[0] === 'GPT' && words[1]) {
    words.splice(0, 2, `GPT-${words[1]}`)
  }

  return words.join(' ') + suffix
}

/** "Claude 2" for a profile: its display name, else its name in title case. */
export function accountLabel(name: string, displayName?: string | null): string {
  if (displayName?.trim()) {
    return displayName.trim()
  }

  return name === 'default' ? 'Default' : titleWords(name.replace(/(\D)(\d+)$/, '$1 $2'))
}
