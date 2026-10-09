import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'safari16',
    sourcemap: false,
    assetsInlineLimit: 0
  }
})
