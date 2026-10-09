// What the app calls the machine Hermes runs on, set per deployment at build time
// (VITE_HM_SERVER_NAME in .env.local); "the server" when unset.
const name = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_HM_SERVER_NAME?.trim()

export const SERVER = name || 'the server'

/** The same name at the start of a sentence. */
export const SERVER_CAP = SERVER.charAt(0).toUpperCase() + SERVER.slice(1)
