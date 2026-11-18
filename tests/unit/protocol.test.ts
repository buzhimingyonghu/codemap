import { describe, expect, it } from 'vitest'
import { encodeMessage, MessageReader } from '../../src/main/dap/protocol'
import { matchesNetworkRule } from '../../src/main/security'

describe('DAP framing', () => {
  it('round-trips messages split across chunks, including multibyte text', () => {
    const first = encodeMessage({ seq: 1, type: 'event', event: 'output', body: { output: '你好 world\n' } })
    const second = encodeMessage({ seq: 2, type: 'response', request_seq: 1, success: true })
    const stream = Buffer.concat([first, second])
    const reader = new MessageReader()
    const messages = [...reader.push(stream.subarray(0, 7)), ...reader.push(stream.subarray(7, first.length + 3)), ...reader.push(stream.subarray(first.length + 3))]
    expect(messages.map((m) => m.seq)).toEqual([1, 2])
    expect(messages[0].body.output).toBe('你好 world\n')
  })
})

describe('plugin network allowlist', () => {
  it('matches exact hosts, wildcards, scheme, and port', () => {
    const rules = ['https://api.example.com', 'https://*.openai.azure.com', 'http://localhost:11434']
    expect(matchesNetworkRule('https://api.example.com/v1/chat', rules)).toBe(true)
    expect(matchesNetworkRule('https://eu.openai.azure.com/x', rules)).toBe(true)
    expect(matchesNetworkRule('https://openai.azure.com/x', rules)).toBe(false)
    expect(matchesNetworkRule('http://api.example.com', rules)).toBe(false)
    expect(matchesNetworkRule('http://localhost:11434/api', rules)).toBe(true)
    expect(matchesNetworkRule('http://localhost:8080/api', rules)).toBe(false)
    expect(matchesNetworkRule('https://evil.com/?https://api.example.com', rules)).toBe(false)
    expect(matchesNetworkRule('file:///etc/passwd', rules)).toBe(false)
    expect(matchesNetworkRule('https://api.example.com', undefined)).toBe(false)
  })
})
