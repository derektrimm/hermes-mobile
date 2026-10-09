import { toast } from './store'

/**
 * Copy text from a tap. The async Clipboard API can be refused (permissions, an iOS focus quirk), so
 * fall back to the selection copy Safari still honours inside a gesture, and say so if both fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)

    return true
  } catch {
    // fall through to the selection copy
  }

  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px'
  document.body.append(area)
  area.select()
  area.setSelectionRange(0, text.length)

  let ok = false

  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }

  area.remove()

  if (!ok) {
    toast('Could not copy. Press and hold the text to select it instead.', 'error')
  }

  return ok
}
