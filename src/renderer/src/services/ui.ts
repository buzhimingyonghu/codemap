import { getState, setState, uid, type Toast } from '../state/store'

export function notify(message: string, kind: Toast['kind'] = 'info', detail?: string): void {
  const id = uid()
  setState({ toasts: [...getState().toasts.slice(-3), { id, kind, message, detail }] })
  const lifetime = kind === 'error' ? 8000 : 3500
  window.setTimeout(() => dismissToast(id), lifetime)
}

export function dismissToast(id: number): void {
  setState({ toasts: getState().toasts.filter((toast) => toast.id !== id) })
}

export function reportError(error: unknown, context?: string): void {
  const message = error instanceof Error ? error.message : String(error)
  notify(context ?? message, 'error', context ? message : undefined)
}

export function prompt(title: string, options: { placeholder?: string; value?: string; confirmLabel?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    getState().prompt?.resolve(null)
    setState({
      prompt: {
        title,
        ...options,
        resolve: (value) => {
          setState({ prompt: null })
          resolve(value)
        }
      }
    })
  })
}

export async function confirm(message: string, detail: string, confirmLabel: string, destructive = false): Promise<boolean> {
  const response = await window.codemap.app.confirm({
    message,
    detail,
    buttons: [confirmLabel, 'Cancel'],
    cancelId: 1,
    defaultId: destructive ? 1 : 0,
    destructive
  })
  return response === 0
}
