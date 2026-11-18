import type { CodemapApi } from '../shared/api'

declare global {
  interface Window {
    codemap: CodemapApi
  }
}

export {}
