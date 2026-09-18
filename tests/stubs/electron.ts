/**
 * Minimal electron stand-in for unit/integration tests.
 * Only the surface the main-process modules touch at import time is provided.
 */
export const app = {
  isPackaged: false,
  /*
   * `FORGE_TEST_USERDATA` lets a test point userData somewhere it may actually
   * write. The default is fine for tests that only need a path to exist in a
   * string; anything that puts bytes on disk — installing an asset pack — has
   * to own a real directory it can clean up afterwards.
   */
  getPath: (name: string): string =>
    `${process.env.FORGE_TEST_USERDATA ?? '/tmp/forge-test'}/${name}`
}
