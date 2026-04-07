import { describe, it, expect } from '@jest/globals'
import { createHmac } from 'node:crypto'
import { verifySignature } from '../lambda/line.mjs'

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
