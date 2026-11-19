export interface HostRequest {
  type: 'request'
  requestId: string
  channel: string
  args: unknown[]
}

export interface HostResponse {
  type: 'response'
  requestId: string
  ok: boolean
  value?: unknown
  error?: string
}

export interface HostEvent {
  type: 'event'
  channel: string
  payload?: unknown
}

export function isHostRequest(value: unknown): value is HostRequest {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<HostRequest>
  return message.type === 'request' && typeof message.requestId === 'string' && typeof message.channel === 'string' && Array.isArray(message.args)
}
