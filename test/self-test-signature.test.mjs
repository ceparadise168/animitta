import { describe, it, expect, jest } from '@jest/globals'

const mockVerifySignature = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({ verifySignature: mockVerifySignature }))
// The self-test sorts with the bot's own question; that is not what is tried here.
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({ sortTalk: jest.fn() }))

const { selfTest } = await import('../lambda/self-test.mjs')

const anthropic = { chatCompletion: jest.fn().mockResolvedValue({ text: '好' }) }
const signature = async () => JSON.parse((await selfTest({ anthropic, backup: null, secret: 's' })).body).signature

describe('selfTest signature check', () => {
  it('fails when the signature check rejects a correctly signed body', async () => {
    mockVerifySignature.mockReturnValue(false)

    expect(await signature()).toBe('failed')
  })

  it('fails when the signature check accepts a forged signature too', async () => {
    mockVerifySignature.mockReturnValue(true)

    expect(await signature()).toBe('failed')
  })
})
