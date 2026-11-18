import { useSyncExternalStore } from 'react'
import { isLocale, localeFrom, translate, type Locale } from '@shared/i18n'

// The renderer's current language. `t()` works anywhere (services, menus, the map canvas);
// components call `useLocale()` so they re-render when the language changes.

const STORAGE_KEY = 'ui.locale'
const listeners = new Set<() => void>()

function initial(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY)
  return isLocale(saved) ? saved : localeFrom(navigator.language)
}

let current: Locale = initial()
document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en'

export function getLocale(): Locale {
  return current
}

export function setLocale(locale: Locale): void {
  if (locale === current) return
  current = locale
  localStorage.setItem(STORAGE_KEY, locale)
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  void window.codemap?.app.setLocale(locale).catch(() => undefined)
  for (const listener of [...listeners]) listener()
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(current, key, vars)
}

/** Subscribes the calling component to language changes and returns the active locale. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale)
}
