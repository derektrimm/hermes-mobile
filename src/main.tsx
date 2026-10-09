import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { start } from './lib/hermes'
import { watchForUpdates } from './lib/update'
import './styles.css'

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  void navigator.serviceWorker.register('/sw.js')
}

start()
watchForUpdates()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
