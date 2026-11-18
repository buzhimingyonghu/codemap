import { Emitter, type Disposable } from '../lib/events'

const services = new Map<string, unknown>()
const registered = new Emitter<{ name: string; implementation: unknown }>()

export function provideService(name: string, implementation: unknown): Disposable {
  services.set(name, implementation)
  registered.emit({ name, implementation })
  return {
    dispose: () => {
      if (services.get(name) === implementation) services.delete(name)
    }
  }
}

export function getService<T>(name: string): T | undefined {
  return services.get(name) as T | undefined
}

export function onServiceRegistered(name: string, listener: (implementation: unknown) => void): Disposable {
  return registered.on((event) => {
    if (event.name === name) listener(event.implementation)
  })
}
