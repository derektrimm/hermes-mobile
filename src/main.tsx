import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { openFromNotification, start } from './lib/hermes'
import { watchPresence } from './lib/push'
import { watchForUpdates } from './lib/update'
import './styles.css'

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  void navigator.serviceWorker.register('/sw.js')
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'open-chat' && typeof event.data.chat?.id === 'string') {
      openFromNotification({ id: event.data.chat.id, profile: String(event.data.chat.profile || 'default') })
    }
  })
}

start()
watchForUpdates()
watchPresence()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
