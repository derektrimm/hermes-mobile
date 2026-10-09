// Unsent text per chat, keyed by stored chat id (or "new:<profile>" before the chat exists). It
// survives a reload, a relaunch and a trip to another app.
const DRAFTS_KEY = 'hermes-mobile:drafts'

export const drafts = new Map<string, string>(readDrafts())

function readDrafts(): Array<[string, string]> {
  try {
    return Object.entries(JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') as Record<string, string>)
  } catch {
    return []
  }
}

export function saveDraft(key: string, text: string) {
  drafts.delete(key)

  if (text) {
    drafts.set(key, text) // newest last, so the oldest are dropped first
  }

  while (drafts.size > 40) {
    drafts.delete(drafts.keys().next().value as string)
  }

  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)))
  } catch {
    // private mode or storage full: drafts stay in memory
  }
}
