import type { ForgeBridge } from './index'

declare global {
  interface Window {
    forge: ForgeBridge
  }
}

export {}
