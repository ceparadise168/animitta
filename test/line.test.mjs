import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { createHmac } from 'node:crypto'
import { verifySignature, replyWithQuickReplyMessage } from '../lambda/line.mjs'

const mockFetch = jest.fn()
global.fetch = mockFetch
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'line-token'

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

describe('replyWithQuickReplyMessage', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('sends LINE message quick reply actions', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })

    await replyWithQuickReplyMessage('reply-token', '回覆', [
      { label: '空性', text: '空性' },
    ])

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.replyToken).toBe('reply-token')
    expect(body.messages[0].quickReply.items[0].action).toEqual({
      type: 'message',
      label: '空性',
      text: '空性',
    })
  })
})
