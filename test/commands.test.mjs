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
  RETENTION_DAYS: 45,
}))

const mockReplyAndRemember = jest.fn()
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({
  replyAndRemember: mockReplyAndRemember,
}))

jest.unstable_mockModule('../lambda/services/voice.mjs', () => ({ VOICE_MINUTES_PER_MONTH: 25 }))

const { handleCommand, handlePostback, isCommand } = await import('../lambda/commands.mjs')

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

  it('tells users how long their words are kept, from the same number the memory uses', async () => {
    await handleCommand('user1', 'token1', '@關於')

    const text = mockReplyMessage.mock.calls[0][1]
    expect(text).toContain('45 天沒來聊天，也會全部自動刪掉')
    expect(text).toContain('「清除記憶」')
    expect(text).toContain('Anthropic 的 Claude')
  })

  it('tells users what their words are used for, and that encryption does not keep them from the AI service', async () => {
    await handleCommand('user1', 'token1', '@關於')

    const text = mockReplyMessage.mock.calls[0][1]
    expect(text).toContain('只用來讓它接得上話，不會拿去做別的事')
    expect(text).toContain('都有加密，不過要產生回覆，你傳的文字還是會交給 AI 服務')
  })

  it('tells users where a voice message goes, that the recording is deleted, and the monthly limit the voice service enforces', async () => {
    await handleCommand('user1', 'token1', '@關於')

    const text = mockReplyMessage.mock.calls[0][1]
    expect(text).toContain('會先交給 Amazon 的語音辨識轉成文字，轉好就把錄音刪掉')
    expect(text).toContain('每個月最多可以傳 25 分鐘')
  })


  it.each([
    ['the menu button', () => handlePostback('user1', 'token1', 'action=daily_line', Date.parse('2026-11-23T09:00:00+08:00'))],
    ['the typed command', () => handleCommand('user1', 'token1', '@今天的一句', Date.parse('2026-11-23T09:00:00+08:00'))],
  ])("gives today's line from %s and remembers it, so the next message answers it", async (_, press) => {
    await press()

    const [userId, replyToken, userSide, text, sentAt] = mockReplyAndRemember.mock.calls[0]
    expect([userId, replyToken, userSide]).toEqual(['user1', 'token1', '（按了選單的「今天的一句」）'])
    expect(text).toMatch(/^今天的一句\n\n「.+」\n——〈.+分第.+〉\n\n不用急著懂它/)
    expect(sentAt).toBe(Date.parse('2026-11-23T09:00:00+08:00'))
  })

  it('recognises only the exact menu texts as commands', () => {
    expect(['@隨意聊聊', '@今天的一句', '@清除記憶', '@關於'].every(isCommand)).toBe(true)
    expect(isCommand('@_@ 今天好累')).toBe(false)
    expect(isCommand('@關於 你是誰')).toBe(false)
    expect(isCommand('toString')).toBe(false)
  })

})
