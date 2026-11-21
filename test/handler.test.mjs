import { describe, it, expect, jest, beforeEach } from '@jest/globals'

process.env.LINE_CHANNEL_SECRET = 'test-secret'

const mockHandleText = jest.fn()
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({
  handleText: mockHandleText,
}))

const mockVerifySignature = jest.fn()
const mockReplyMessage = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  verifySignature: mockVerifySignature,
  replyMessage: mockReplyMessage,
  replyWithQuickReply: jest.fn(),
  replyWithQuickReplyMessage: jest.fn(),
  showLoadingIndicator: jest.fn().mockResolvedValue(undefined),
  linkRichMenu: jest.fn().mockResolvedValue(undefined),
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

  it('asks the user to type instead when a voice message arrives', async () => {
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

    expect(mockReplyMessage).toHaveBeenCalledWith('tok', expect.stringContaining('打字'))
    expect(mockHandleText).not.toHaveBeenCalled()
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

  const textEvent = {
    events: [
      {
        type: 'message',
        replyToken: 'tok',
        source: { userId: 'u1' },
        message: { type: 'text', text: '你好' },
      },
    ],
  }

  it('sends a fallback reply when the LLM call fails', async () => {
    mockHandleText.mockRejectedValue(new Error('Anthropic chat failed: 401'))
    mockReplyMessage.mockResolvedValue(undefined)

    const result = await handler(makeEvent(textEvent))

    expect(result.statusCode).toBe(200)
    expect(mockReplyMessage).toHaveBeenCalledTimes(1)
    expect(mockReplyMessage).toHaveBeenCalledWith('tok', expect.stringContaining('暫時'))
  })

  it('still returns 200 when the fallback reply is rejected', async () => {
    mockHandleText.mockRejectedValue(new Error('DynamoDB save failed'))
    mockReplyMessage.mockRejectedValue(new Error('LINE reply failed: 400'))

    const result = await handler(makeEvent(textEvent))

    expect(result.statusCode).toBe(200)
  })
})
