// iOS Safari and home-screen apps have no navigator.vibrate, but toggling a native switch control
// (iOS 17.4+) plays the system haptic. A hidden one is toggled for each tap that deserves a tick.
let toggle: HTMLLabelElement | null = null

export function haptic() {
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(10)

    return
  }

  if (!toggle) {
    toggle = document.createElement('label')
    toggle.setAttribute('aria-hidden', 'true')
    toggle.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    input.tabIndex = -1
    toggle.appendChild(input)
    document.body.appendChild(toggle)
  }

  toggle.click()
}
