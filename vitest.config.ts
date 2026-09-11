import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // Main-process modules import electron at load time; tests run outside it.
      electron: resolve(__dirname, 'tests/stubs/electron.ts')
    }
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 120_000
  }
})
