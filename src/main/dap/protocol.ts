// Minimal framing for the Debug Adapter Protocol: `Content-Length: N\r\n\r\n<json>`.

export interface DapMessage {
  seq: number
  type: 'request' | 'response' | 'event'
  command?: string
  event?: string
  request_seq?: number
  success?: boolean
  message?: string
  body?: any
  arguments?: any
}

export function encodeMessage(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

export class MessageReader<T = DapMessage> {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): T[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: T[] = []
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) break
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) break
      const json = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        messages.push(JSON.parse(json) as T)
      } catch {
        /* ignore malformed frame */
      }
    }
    return messages
  }
}
