/**
 * Parse a user-entered timecode into seconds.
 * Accepts "90", "1:30", "01:02:03", "1:30.5". Returns null for blank/invalid.
 */
export function parseTime(input: string): number | null {
  const raw = (input ?? '').trim()
  if (raw === '') return null
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(raw)) return null

  const parts = raw.split(':')
  let seconds = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isFinite(n)) return null
    seconds = seconds * 60 + n
  }
  return seconds
}

/** Seconds -> "1:02:03.4" style, used for display only. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}
