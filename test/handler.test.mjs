import { describe, it, expect, jest, beforeEach } from '@jest/globals'

process.env.LINE_CHANNEL_SECRET = 'test-secret'

const mockHandleText = jest.fn()
const mockHandleAudio = jest.fn()
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({
  handleText: mockHandleText,
  handleAudio: mockHandleAudio,
}))

const mockVerifySignature = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  verifySignature: mockVerifySignature,
  replyMessage: jest.fn(),
  replyWithQuickReply: jest.fn(),
  downloadContent: jest.fn(),
  showLoadingIndicator: jest.fn().mockResolvedValue(undefined),
}))

const mockHandleCommand = jest.fn()
const mockHandlePostback = jest.fn()
const mockTryHandleFeedbackText = jest.fn()
jest.unstable_mockModule('../lambda/commands.mjs', () => ({
  handleCommand: mockHandleCommand,
  handlePostback: mockHandlePostback,
  tryHandleFeedbackText: mockTryHandleFeedbackText,
}))

const { handler } = await import('../lambda/index.mjs')

describe('Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifySignature.mockReturnValue(true)
    mockHandleText.mockResolvedValue(undefined)
    mockHandleAudio.mockResolvedValue(undefined)
    mockHandleCommand.mockResolvedValue(undefined)
    mockHandlePostback.mockResolvedValue(undefined)
    mockTryHandleFeedbackText.mockResolvedValue(false)
  })

  function makeEvent(body, signature = 'valid-sig') {
    return {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'x-line-signature': signature },
    }
  }

  it('returns 200 for valid text message', async () => {
    const body = {
      events: [
        {
          type: 'message',
          replyToken: 'tok',
          source: { userId: 'u1' },
          message: { type: 'text', text: '你好' },
        },
      ],
    }

    const result = await handler(makeEvent(body))

    expect(result.statusCode).toBe(200)
    expect(mockHandleText).toHaveBeenCalledWith('u1', 'tok', '你好')
  })

  it('routes audio messages to handleAudio', async () => {
    const body = {
      events: [
        {
          type: 'message',
          replyToken: 'tok',
          source: { userId: 'u1' },
          message: { type: 'audio', id: 'audio123' },
        },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandleAudio).toHaveBeenCalledWith('u1', 'tok', 'audio123')
  })

  it('rejects invalid signature with 401', async () => {
    mockVerifySignature.mockReturnValue(false)

    const result = await handler(
      makeEvent({ events: [] }, 'bad-sig')
    )

    expect(result.statusCode).toBe(401)
  })

  it('returns 200 for empty events', async () => {
    const result = await handler(makeEvent({ events: [] }))

    expect(result.statusCode).toBe(200)
    expect(mockHandleText).not.toHaveBeenCalled()
  })

  it('routes @-prefixed text to handleCommand', async () => {
    const body = {
      events: [
        {
          type: 'message',
          replyToken: 'tok',
          source: { userId: 'u1' },
          message: { type: 'text', text: '@隨意聊聊' },
        },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandleCommand).toHaveBeenCalledWith('u1', 'tok', '@隨意聊聊')
    expect(mockHandleText).not.toHaveBeenCalled()
  })

  it('routes postback events to handlePostback', async () => {
    const body = {
      events: [
        {
          type: 'postback',
          replyToken: 'tok',
          source: { userId: 'u1' },
          postback: { data: 'feedback:good' },
        },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandlePostback).toHaveBeenCalledWith('u1', 'tok', 'feedback:good')
  })
})
