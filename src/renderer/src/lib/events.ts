export interface Disposable {
  dispose(): void
}

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>()

  on(listener: (value: T) => void): Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value)
      } catch (error) {
        console.error(error)
      }
    }
  }
}

export function toDisposable(fn: () => void): Disposable {
  return { dispose: fn }
}
