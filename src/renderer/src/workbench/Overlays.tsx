import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { dismissToast } from '../services/ui'
import { t } from '../lib/i18n'
import { useStore } from '../state/store'

export function PromptDialog() {
  const request = useStore((s) => s.prompt)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!request) return
    setValue(request.value ?? '')
    requestAnimationFrame(() => inputRef.current?.select())
  }, [request])

  if (!request) return null
  return (
    <div className="overlay overlay--top" onMouseDown={() => request.resolve(null)}>
      <form
        className="prompt"
        role="dialog"
        aria-label={request.title}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          request.resolve(value.trim() ? value : null)
        }}
      >
        <label className="prompt-title" htmlFor="prompt-input">
          {request.title}
        </label>
        <input
          id="prompt-input"
          ref={inputRef}
          className="input"
          value={value}
          placeholder={request.placeholder}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && request.resolve(null)}
        />
        <div className="prompt-actions">
          <button type="button" className="button" onClick={() => request.resolve(null)}>
            {t('Cancel')}
          </button>
          <button type="submit" className="button button--primary" disabled={!value.trim()}>
            {request.confirmLabel ?? t('OK')}
          </button>
        </div>
      </form>
    </div>
  )
}

const TOAST_ICON = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = TOAST_ICON[toast.kind]
        return (
          <div key={toast.id} className={`toast toast--${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
            <Icon size={15} className="toast-icon" />
            <div className="toast-text">
              <span className="toast-message">{toast.message}</span>
              {toast.detail ? <span className="toast-detail">{toast.detail}</span> : null}
            </div>
            <button type="button" className="toast-close" aria-label={t('Dismiss')} onClick={() => dismissToast(toast.id)}>
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
