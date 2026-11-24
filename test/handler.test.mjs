import { describe, it, expect, jest, beforeEach } from '@jest/globals'

process.env.LINE_CHANNEL_SECRET = 'test-secret'

const mockHandleText = jest.fn()
const mockReplyAndRemember = jest.fn()
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({
  handleText: mockHandleText,
  replyAndRemember: mockReplyAndRemember,
}))

const mockHandleVoice = jest.fn()
jest.unstable_mockModule('../lambda/services/voice.mjs', () => ({ handleVoice: mockHandleVoice }))

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
  isCommand: (text) => text === '@隨意聊聊',
}))

const mockSelfTest = jest.fn()
jest.unstable_mockModule('../lambda/self-test.mjs', () => ({ selfTest: mockSelfTest }))

const { handler } = await import('../lambda/index.mjs')
const SENT_AT = 1795270000000

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
          timestamp: SENT_AT, source: { type: 'user', userId: 'u1' },
          message: { type: 'text', text: '你好' },
        },
      ],
    }

    const result = await handler(makeEvent(body))

    expect(result.statusCode).toBe(200)
    expect(mockHandleText).toHaveBeenCalledWith('u1', 'tok', '你好', SENT_AT)
  })

  it('hands a voice message recorded in LINE to the voice service', async () => {
    const message = { type: 'audio', id: 'audio123', duration: 12000, contentProvider: { type: 'line' } }
    const body = {
      events: [{ type: 'message', replyToken: 'tok', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message }],
    }

    await handler(makeEvent(body))

    expect(mockHandleVoice).toHaveBeenCalledWith('u1', 'tok', message, SENT_AT)
    expect(mockReplyAndRemember).not.toHaveBeenCalled()
  })

  it('asks for a recording made in LINE, or text, when audio hosted elsewhere arrives, which LINE cannot hand over', async () => {
    const message = { type: 'audio', id: 'audio123', contentProvider: { type: 'external', originalContentUrl: 'https://example.com/a.m4a' } }
    const body = {
      events: [{ type: 'message', replyToken: 'tok', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message }],
    }

    await handler(makeEvent(body))

    expect(mockHandleVoice).not.toHaveBeenCalled()
    expect(mockReplyAndRemember).toHaveBeenCalledWith('u1', 'tok', '（傳了一段語音）', expect.stringContaining('在 LINE 裡錄音'), SENT_AT)
  })

  it('asks for text when a photo arrives, and remembers that a photo came', async () => {
    const body = {
      events: [{ type: 'message', replyToken: 'tok', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message: { type: 'image', id: 'img1' } }],
    }

    await handler(makeEvent(body))

    expect(mockReplyAndRemember).toHaveBeenCalledWith('u1', 'tok', '（傳了一張圖片）', expect.stringContaining('打字'), SENT_AT)
  })

  it('passes a sticker to the model as words, from its keywords and text', async () => {
    const sticker = (message) => ({
      events: [{ type: 'message', replyToken: 'tok', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message: { type: 'sticker', ...message } }],
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
        { type: 'message', replyToken: 'tok-a', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message: { type: 'text', text: '你好' } },
        { type: 'message', replyToken: 'tok-b', timestamp: SENT_AT, source: { type: 'user', userId: 'u2' }, message: { type: 'text', text: '嗨' } },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandleText).toHaveBeenCalledWith('u1', 'tok-a', '你好', SENT_AT)
    expect(mockHandleText).toHaveBeenCalledWith('u2', 'tok-b', '嗨', SENT_AT)
  })

  it('keeps going when one event in the webhook fails, and apologises on that event only', async () => {
    mockHandleText.mockRejectedValueOnce(new Error('Anthropic chat failed: 529'))
    mockReplyMessage.mockResolvedValue(undefined)
    const body = {
      events: [
        { type: 'message', replyToken: 'tok-a', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message: { type: 'text', text: '你好' } },
        { type: 'message', replyToken: 'tok-b', timestamp: SENT_AT, source: { type: 'user', userId: 'u2' }, message: { type: 'text', text: '嗨' } },
      ],
    }

    const result = await handler(makeEvent(body))

    expect(result.statusCode).toBe(200)
    expect(mockHandleText).toHaveBeenCalledWith('u2', 'tok-b', '嗨', SENT_AT)
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
          timestamp: SENT_AT, source: { type: 'user', userId: 'u1' },
          message: { type: 'text', text: '@隨意聊聊' },
        },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandleCommand).toHaveBeenCalledWith('u1', 'tok', '@隨意聊聊', SENT_AT)
    expect(mockHandleText).not.toHaveBeenCalled()
  })

  it('treats text that only starts with @ as a message, not a command', async () => {
    const body = {
      events: [{ type: 'message', replyToken: 'tok', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message: { type: 'text', text: '@_@ 今天好累' } }],
    }

    await handler(makeEvent(body))

    expect(mockHandleCommand).not.toHaveBeenCalled()
    expect(mockHandleText).toHaveBeenCalledWith('u1', 'tok', '@_@ 今天好累', SENT_AT)
  })

  it('still answers the other events when one event carries no source', async () => {
    const body = {
      events: [
        { type: 'activated', chatControl: {} },
        { type: 'message', replyToken: 'tok', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message: { type: 'text', text: '你好' } },
      ],
    }

    const result = await handler(makeEvent(body))

    expect(result.statusCode).toBe(200)
    expect(mockHandleText).toHaveBeenCalledWith('u1', 'tok', '你好', SENT_AT)
  })

  it('ignores a user event that carries no userId, rather than filing it under a shared key', async () => {
    const body = {
      events: [{ type: 'message', replyToken: 'tok', timestamp: SENT_AT, source: { type: 'user' }, message: { type: 'text', text: '你好' } }],
    }

    await handler(makeEvent(body))

    expect(mockHandleText).not.toHaveBeenCalled()
  })

  it('stays out of group chats, where every member would share one memory', async () => {
    const body = {
      events: [{ type: 'message', replyToken: 'tok', source: { type: 'group', groupId: 'g1' }, message: { type: 'text', text: '欸大家' } }],
    }

    await handler(makeEvent(body))

    expect(mockHandleText).not.toHaveBeenCalled()
    expect(mockReplyMessage).not.toHaveBeenCalled()
  })

  it('logs failures as "Handler error", the text the CloudWatch alarm counts', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockHandleText.mockRejectedValue(new Error('Anthropic chat failed: 529'))
    const body = {
      events: [{ type: 'message', replyToken: 'tok', timestamp: SENT_AT, source: { type: 'user', userId: 'u1' }, message: { type: 'text', text: '你好' } }],
    }

    await handler(makeEvent(body))

    expect(logged).toHaveBeenCalledWith('Handler error:', expect.any(Error))
    logged.mockRestore()
  })

  it('routes postback events to handlePostback', async () => {
    const body = {
      events: [
        {
          type: 'postback',
          replyToken: 'tok',
          timestamp: SENT_AT, source: { type: 'user', userId: 'u1' },
          postback: { data: 'action=casual_chat' },
        },
      ],
    }

    await handler(makeEvent(body))

    expect(mockHandlePostback).toHaveBeenCalledWith('u1', 'tok', 'action=casual_chat', SENT_AT)
  })

  const textEvent = {
    events: [
      {
        type: 'message',
        replyToken: 'tok',
        timestamp: SENT_AT, source: { type: 'user', userId: 'u1' },
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

  it('runs the self-test for a direct invoke, without touching LINE', async () => {
    mockSelfTest.mockResolvedValueOnce({ statusCode: 200, body: '{"anthropic":"ok"}' })

    const result = await handler({ selfTest: true })

    expect(result).toEqual({ statusCode: 200, body: '{"anthropic":"ok"}' })
    expect(mockVerifySignature).not.toHaveBeenCalled()
  })

  it('never runs the self-test for a request through the webhook URL', async () => {
    mockVerifySignature.mockReturnValueOnce(false)

    const result = await handler({ selfTest: true, requestContext: { http: { method: 'POST' } }, body: '{}', headers: {} })

    expect(result.statusCode).toBe(401)
    expect(mockSelfTest).not.toHaveBeenCalled()
  })

  it('gives the 24-hour hotlines when the words that went unanswered talk of ending a life', async () => {
    const err = Object.assign(new Error('Anthropic chat failed: 529'), { unanswered: '我真的不想活了' })
    mockHandleText.mockRejectedValue(err)
    mockReplyMessage.mockResolvedValue(undefined)

    await handler(makeEvent(textEvent))

    const apology = mockReplyMessage.mock.calls[0][1]
    expect(apology).toContain('1925')
    expect(apology).toContain('1995')
  })

  it('keeps the ordinary apology for everyday exaggeration', async () => {
    const err = Object.assign(new Error('Anthropic chat failed: 529'), { unanswered: '今天累到想死 笑死' })
    mockHandleText.mockRejectedValue(err)
    mockReplyMessage.mockResolvedValue(undefined)

    await handler(makeEvent(textEvent))

    expect(mockReplyMessage.mock.calls[0][1]).not.toContain('1925')
  })

  it('still returns 200 when the fallback reply is rejected', async () => {
    mockHandleText.mockRejectedValue(new Error('DynamoDB save failed'))
    mockReplyMessage.mockRejectedValue(new Error('LINE reply failed: 400'))

    const result = await handler(makeEvent(textEvent))

    expect(result.statusCode).toBe(200)
  })
})
