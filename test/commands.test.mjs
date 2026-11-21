import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'

const mockReplyMessage = jest.fn()
const mockReplyWithQuickReply = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  replyMessage: mockReplyMessage,
  replyWithQuickReply: mockReplyWithQuickReply,
}))

process.env.LLM_PROVIDER = 'anthropic'

const mockClearMemory = jest.fn()
jest.unstable_mockModule('../lambda/services/memory.mjs', () => ({
  clearMemory: mockClearMemory,
  RETENTION_DAYS: { turns: 7, summary: 45 },
}))

const mockReplyAndRemember = jest.fn()
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({
  replyAndRemember: mockReplyAndRemember,
}))

const { handleCommand } = await import('../lambda/commands.mjs')

describe('commands', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReplyMessage.mockResolvedValue(undefined)
    mockReplyWithQuickReply.mockResolvedValue(undefined)
    mockClearMemory.mockResolvedValue(undefined)
    mockReplyAndRemember.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('starts casual chat with a low-pressure invitation instead of a koan quiz', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)

    await handleCommand('user1', 'token1', '@隨意聊聊')

    const [userId, replyToken, , text] = mockReplyAndRemember.mock.calls[0]
    expect([userId, replyToken]).toEqual(['user1', 'token1'])
    expect(text).toContain('不用先想好怎麼說')
    expect(text).toContain('金剛經')
    expect(text).not.toContain('今天想跟你分享一句金剛經')
    expect(text).not.toContain('如果沒有來也沒有去')
  })

  it('describes the product as Diamond Sutra conversation, not a scripture dispenser', async () => {
    await handleCommand('user1', 'token1', '@關於')

    const text = mockReplyMessage.mock.calls[0][1]
    expect(text).toContain('自在聊天')
    expect(text).toContain('金剛經')
    expect(text).not.toContain('分享一句經文')
  })

  it('tells users how long their words are kept, from the same numbers the memory uses', async () => {
    await handleCommand('user1', 'token1', '@關於')

    const text = mockReplyMessage.mock.calls[0][1]
    expect(text).toContain('最多留 7 天')
    expect(text).toContain('45 天沒來聊天，就全部自動刪掉')
    expect(text).toContain('「清除記憶」')
    expect(text).toContain('Anthropic 的 Claude')
  })

})
