import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'

const mockReplyMessage = jest.fn()
const mockReplyWithQuickReply = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  replyMessage: mockReplyMessage,
  replyWithQuickReply: mockReplyWithQuickReply,
}))

const mockClearMemory = jest.fn()
jest.unstable_mockModule('../lambda/services/memory.mjs', () => ({
  clearMemory: mockClearMemory,
}))

const { handleCommand } = await import('../lambda/commands.mjs')

describe('commands', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReplyMessage.mockResolvedValue(undefined)
    mockReplyWithQuickReply.mockResolvedValue(undefined)
    mockClearMemory.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('starts casual chat with a low-pressure invitation instead of a koan quiz', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0)

    await handleCommand('user1', 'token1', '@隨意聊聊')

    const text = mockReplyMessage.mock.calls[0][1]
    expect(text).toContain('不用整理')
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
})
