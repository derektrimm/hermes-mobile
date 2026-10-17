// Files a reply shows on the phone: pictures, video, audio and documents Hermes names in a reply
// ("MEDIA:/path", or a Markdown image of a local path). The chat's own backend reads them; these
// rules decide which ones the phone may ask for at all. The server enforces them and the app uses
// them to say up front what it cannot show, so this module runs in both (no Node imports).
//
// Hermes's file route refuses its own credential files but not, say, ~/.ssh, so only these types
// are served, from no hidden folder except Hermes's own media folders, and always with the type
// below, never the backend's.

export const FILE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  zip: 'application/zip'
}

// Where Hermes writes the media it makes, inside its home and each profile's.
const HERMES_MEDIA_DIRS = new Set(['cache', 'images', 'screenshots'])

/** The extension, lower case, without the dot ('' when the name has none). */
export function fileExtension(filePath) {
  const name = String(filePath).split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function fileType(filePath) {
  return FILE_TYPES[fileExtension(filePath)] ?? null
}

export function fileAllowed(filePath) {
  if (typeof filePath !== 'string' || filePath.length > 4096 || filePath.includes('\0') || !/^(\/|~\/)/.test(filePath)) {
    return false
  }

  const parts = filePath.split('/').filter(Boolean)

  if (parts.includes('..') || parts.includes('.') || !fileType(filePath) || parts[parts.length - 1].startsWith('.')) {
    return false
  }

  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === '~' || !parts[i].startsWith('.')) {
      continue
    }

    if (parts[i] !== '.hermes') {
      return false
    }

    // ~/.hermes/<media>/... or ~/.hermes/profiles/<name>/<media>/...
    if (HERMES_MEDIA_DIRS.has(parts[i + 1])) {
      i += 1
    } else if (parts[i + 1] === 'profiles' && parts[i + 2] && !parts[i + 2].startsWith('.') && HERMES_MEDIA_DIRS.has(parts[i + 3])) {
      i += 3
    } else {
      return false
    }
  }

  return true
}
