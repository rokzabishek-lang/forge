/**
 * Minimal electron stand-in for unit/integration tests.
 * Only the surface the main-process modules touch at import time is provided.
 */
export const app = {
  isPackaged: false,
  getPath: (name: string): string => `/tmp/forge-test/${name}`
}
