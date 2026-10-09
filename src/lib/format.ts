import type { Chat } from './store'

/** A chat's title for display: Hermes sometimes titles a chat from an internal note in brackets. */
export function displayTitle(title: string | null | undefined, fallback = 'New chat'): string {
  const clean = (title || '').replace(/^\s*\[[^\]]*\]?\s*/, '').trim()

  return clean || fallback
}

export type Place = { word: string; sentence: string; busy: boolean } | null

/** Where a chat is live, when that is not on the phone: drives the header dot and place word. */
export function placeOf(chat: Chat): Place {
  if (chat.shared) {
    const pc = chat.shared.holder === 'pc-shared'

    return {
      word: pc ? 'On PC' : 'Desktop app',
      sentence: chat.shared.windowless
        ? 'Runs on your PC: its commands run there, though no Hermes window has it open. Open it in a window with hermes --resume and the window joins this same chat.'
        : pc
          ? 'Live in a Hermes window on your PC. The window and this phone drive the same chat: either can send, stop or answer, and its commands run on your PC.'
          : 'Live in the desktop app. The app and this phone drive the same chat: either can send, stop or answer.',
      busy: chat.running
    }
  }

  if (chat.watch) {
    const pc = chat.watch.holder === 'pc-window'

    return {
      word: pc ? 'On PC' : chat.watch.holder === 'desktop-app' ? 'Desktop app' : 'Elsewhere',
      sentence: pc
        ? 'Live in a Hermes window on your PC. The phone is joining it; type any time.'
        : `Open in ${chat.watch.holder_label}, updating live.`,
      busy: chat.running
    }
  }

  return null
}

/** Drawer time: 14:02 today, weekday this week, Oct 2 before that. */
export function rowTime(ts: number | null | undefined): string {
  if (!ts) {
    return ''
  }

  const date = new Date(ts * 1000)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  if (date.getTime() >= startOfToday) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }

  if (date.getTime() >= startOfToday - 6 * 86_400_000) {
    return date.toLocaleDateString(undefined, { weekday: 'short' })
  }

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
