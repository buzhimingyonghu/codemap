import { randomUUID } from 'node:crypto'
import type { HostRequest, HostResponse } from './protocol'

export type RpcHandler = (args: unknown[]) => Promise<unknown> | unknown

export function responseFor(message: HostRequest, value?: unknown, error?: string): HostResponse {
  if (error !== undefined) return { type: 'response', requestId: message.requestId, ok: false, error }
  return { type: 'response', requestId: message.requestId, ok: true, value }
}

export async function dispatch(message: HostRequest, handlers: Record<string, RpcHandler>): Promise<HostResponse> {
  const handler = handlers[message.channel]
  if (!handler) return responseFor(message, undefined, `Unknown channel: ${message.channel}`)
  try {
    return responseFor(message, await handler(message.args))
  } catch (error) {
    return responseFor(message, undefined, error instanceof Error ? error.message : String(error))
  }
}

export function request(channel: string, args: unknown[] = []): HostRequest {
  return { type: 'request', requestId: randomUUID(), channel, args }
}
