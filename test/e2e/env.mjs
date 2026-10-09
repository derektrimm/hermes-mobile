// Settings for the end-to-end tests, from .env.local (see .env.example) unless already in the
// environment: the deployed app's address and a checkout that has Playwright installed.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env.local'))
} catch {
  // no .env.local: the variables must come from the environment
}

const need = name => {
  if (!process.env[name]) {
    console.error(`test: set ${name} (in .env.local, see .env.example)`)
    process.exit(2)
  }

  return process.env[name]
}

export const BASE = need('HM_BASE')
export const { chromium, devices } = createRequire(need('HM_PLAYWRIGHT_FROM'))('playwright')
