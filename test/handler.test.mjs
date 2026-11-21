import { describe, it, expect, jest, beforeEach } from '@jest/globals'

process.env.LINE_CHANNEL_SECRET = 'test-secret'

const mockHandleText = jest.fn()
const mockReplyAndRemember = jest.fn()
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({
  handleText: mockHandleText,
  replyAndRemember: mockReplyAndRemember,
}))

const mockVerifySignature = jest.fn()
const mockReplyMessage = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  verifySignature: mockVerifySignature,
  replyMessage: mockReplyMessage,
  replyWithQuickReply: jest.fn(),
  showLoadingIndicator: jest.fn().mockResolvedValue(undefined),
  linkRichMenu: jest.fn().mockResolvedValue(undefined),
}))

const mockHandleCommand = jest.fn()
const mockHandlePostback = jest.fn()
jest.unstable_mockModule('../lambda/commands.mjs', () => ({
  handleCommand: mockHandleCommand,
  handlePostback: mockHandlePostback,
}))

const { handler } = await import('../lambda/index.mjs')

describe('Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifySignature.mockReturnValue(true)
    mockHandleText.mockResolvedValue(undefined)
    mockReplyAndRemember.mockResolvedValue(undefined)
    mockHandleCommand.mockResolvedValue(undefined)
    mockHandlePostback.mockResolvedValue(undefined)
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

    expect(mockReplyAndRemember).toHaveBeenCalledWith('u1', 'tok', '（傳了一段語音）', expect.stringContaining('打字'))
    expect(mockHandleText).not.toHaveBeenCalled()
  })

  it('asks for text when a photo arrives, and remembers that a photo came', async () => {
    const body = {
      events: [{ type: 'message', replyToken: 'tok', source: { userId: 'u1' }, message: { type: 'image', id: 'img1' } }],
    }

    await handler(makeEvent(body))

    expect(mockReplyAndRemember).toHaveBeenCalledWith('u1', 'tok', '（傳了一張圖片）', expect.stringContaining('打字'))
  })

  it('passes a sticker to the model as words, from its keywords and text', async () => {
    const sticker = (message) => ({
      events: [{ type: 'message', replyToken: 'tok', source: { userId: 'u1' }, message: { type: 'sticker', ...message } }],
    })

    await handler(makeEvent(sticker({ keywords: ['cry', 'sad'] })))
    await handler(makeEvent(sticker({ keywords: ['tired'], text: '好累\n喔' })))
    await handler(makeEvent(sticker({})))

    expect(mockHandleText.mock.calls.map((call) => call[2])).toEqual([
      '（傳了一張貼圖：cry、sad）',
      '（傳了一張貼圖：tired，上面寫著「好累 喔」）',
      '（傳了一張貼圖）',
    ])
  })

  it('handles every event in one webhook, including other users', async () => {
    const body = {
      events: [
        { type: 'message', replyToken: 'tok-a', source: { userId: 'u1' }, message: { type: 'text', text: '你好' } },
        { type: 'message', replyToken: 'tok-b', source: { userId: 'u2' }, message: { type: 'text', text: '嗨' } },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandleText).toHaveBeenCalledWith('u1', 'tok-a', '你好')
    expect(mockHandleText).toHaveBeenCalledWith('u2', 'tok-b', '嗨')
  })

  it('keeps going when one event in the webhook fails, and apologises on that event only', async () => {
    mockHandleText.mockRejectedValueOnce(new Error('Anthropic chat failed: 529'))
    mockReplyMessage.mockResolvedValue(undefined)
    const body = {
      events: [
        { type: 'message', replyToken: 'tok-a', source: { userId: 'u1' }, message: { type: 'text', text: '你好' } },
        { type: 'message', replyToken: 'tok-b', source: { userId: 'u2' }, message: { type: 'text', text: '嗨' } },
      ],
    }

    const result = await handler(makeEvent(body))

    expect(result.statusCode).toBe(200)
    expect(mockHandleText).toHaveBeenCalledWith('u2', 'tok-b', '嗨')
    expect(mockReplyMessage).toHaveBeenCalledTimes(1)
    expect(mockReplyMessage).toHaveBeenCalledWith('tok-a', expect.stringContaining('暫時'))
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
          postback: { data: 'action=casual_chat' },
        },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandlePostback).toHaveBeenCalledWith('u1', 'tok', 'action=casual_chat')
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
