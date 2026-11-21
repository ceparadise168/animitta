import { describe, it, expect, jest, afterEach } from '@jest/globals'
import { createHmac } from 'node:crypto'
import { verifySignature, showLoadingIndicator } from '../lambda/line.mjs'


describe('verifySignature', () => {
  const secret = 'test-channel-secret'

  it('returns true for valid signature', () => {
    const body = '{"events":[]}'
    const expected = createHmac('SHA256', secret)
      .update(body)
      .digest('base64')

    expect(verifySignature(body, expected, secret)).toBe(true)
  })

  it('returns false for invalid signature', () => {
    const body = '{"events":[]}'
    expect(verifySignature(body, 'invalid-sig', secret)).toBe(false)
  })

  it('returns false for tampered body', () => {
    const body = '{"events":[]}'
    const sig = createHmac('SHA256', secret)
      .update(body)
      .digest('base64')

    expect(verifySignature('{"events":[{}]}', sig, secret)).toBe(false)
  })
})

describe('showLoadingIndicator', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it('starts the typing animation through the LINE loading/start endpoint', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 202 })
    global.fetch = mockFetch

    await showLoadingIndicator('U123')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/chat/loading/start',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ chatId: 'U123' }) })
    )
  })

  it('rejects when LINE does not accept the request, so the failure can be logged', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 })

    await expect(showLoadingIndicator('U123')).rejects.toThrow('LINE loading indicator failed: 404')
  })
})
