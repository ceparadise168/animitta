import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'

const mockReplyMessage = jest.fn()
const mockReplyWithQuickReply = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  replyMessage: mockReplyMessage,
  replyWithQuickReply: mockReplyWithQuickReply,
}))

process.env.LLM_PROVIDER = 'anthropic'
process.env.BEDROCK_MODEL_ID = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0'

const mockClearMemory = jest.fn()
jest.unstable_mockModule('../lambda/services/memory.mjs', () => ({
  clearMemory: mockClearMemory,
  RETENTION_DAYS: 45,
}))

const mockReplyAndRemember = jest.fn()
const mockHandleText = jest.fn()
jest.unstable_mockModule('../lambda/services/chat.mjs', () => ({
  replyAndRemember: mockReplyAndRemember,
  handleText: mockHandleText,
}))

jest.unstable_mockModule('../lambda/services/voice.mjs', () => ({ VOICE_MINUTES_PER_MONTH: 25 }))

const { handleCommand, handlePostback, isCommand } = await import('../lambda/commands.mjs')
const { DAILY_LINES, todaysLine } = await import('../lambda/sutra.mjs')

describe('commands', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReplyMessage.mockResolvedValue(undefined)
    mockReplyWithQuickReply.mockResolvedValue(undefined)
    mockClearMemory.mockResolvedValue(undefined)
    mockReplyAndRemember.mockResolvedValue(undefined)
    mockHandleText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('opens casual chat without the sutra, because 每日一句 is the way in with a sutra line', async () => {
    const random = jest.spyOn(Math, 'random')
    for (let i = 0; i < 100; i++) {
      random.mockReturnValue(i / 100)
      await handleCommand('user1', 'token1', '@隨意聊聊')
    }

    const calls = mockReplyAndRemember.mock.calls
    expect(new Set(calls.map(([, , , text]) => text)).size).toBeGreaterThan(1)
    for (const [userId, replyToken, remembered, text] of calls) {
      expect([userId, replyToken, remembered]).toEqual(['user1', 'token1', '（按了選單的「隨意聊聊」）'])
      expect(text).not.toMatch(/金剛經|經文/)
      for (const [, quoted] of text.matchAll(/「([^」]+)」/g)) expect(isCommand(`@${quoted}`)).toBe(true)
    }
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
    expect(text).toContain('45 天未互動自動清空')
    expect(text).toContain('「清除記憶」')
  })

  it('says what the memory is for, and promises encryption only in transit and at rest, because the AI service still reads the text', async () => {
    await handleCommand('user1', 'token1', '@關於')

    const text = mockReplyMessage.mock.calls[0][1]
    expect(text).toContain('記憶只用來接話')
    expect(text).toContain('對話傳送與存放都加密')
    expect(text).toMatch(/文字由 .+ 處理/)
    expect(text).not.toContain('全程加密')
  })

  it('tells users their words may go to Amazon instead when the backup is on', async () => {
    await handleCommand('user1', 'token1', '@關於')

    expect(mockReplyMessage.mock.calls[0][1]).toContain(
      '文字由 Anthropic 或 Amazon 日本機房的 Claude 處理（不用於訓練）'
    )
  })

  it('tells users where a voice message goes, that the recording is deleted, and the monthly limit the voice service enforces', async () => {
    await handleCommand('user1', 'token1', '@關於')

    const text = mockReplyMessage.mock.calls[0][1]
    expect(text).toContain('語音經 Amazon 轉文字後即刪')
    expect(text).toContain('每月上限 25 分鐘')
  })

  // On a phone, the repository's front page shows its file list first; #readme
  // opens it at the README, whose first section is written for these users.
  it('gives the public code a block of its own, with the link alone on its line so LINE makes all of it tappable', async () => {
    await handleCommand('user1', 'token1', '@關於')

    expect(mockReplyMessage.mock.calls[0][1]).toMatch(
      /【原始碼】\n[^\n]+\nhttps:\/\/github\.com\/ceparadise168\/animitta#readme\n/
    )
  })


  it.each([
    ['the menu button', () => handlePostback('user1', 'token1', 'action=daily_line', Date.parse('2026-11-23T09:00:00+08:00'))],
    ['the typed command', () => handleCommand('user1', 'token1', '@每日一句', Date.parse('2026-11-23T09:00:00+08:00'))],
  ])("gives today's line from %s and remembers it, so the next message answers it", async (_, press) => {
    await press()

    const [userId, replyToken, userSide, text, sentAt] = mockReplyAndRemember.mock.calls[0]
    expect([userId, replyToken, userSide]).toEqual(['user1', 'token1', '（按了選單的「每日一句」）'])
    expect(text).toMatch(/^每日一句\n\n「.+」\n——〈.+分第.+〉\n\n不用急著懂它/)
    expect(sentAt).toBe(Date.parse('2026-11-23T09:00:00+08:00'))
  })

  describe("the buttons under a line", () => {
    const MORNING = Date.parse('2026-11-23T09:00:00+08:00')
    const buttonsOf = (call) => call[5].quickReply

    it("offers 多了解這一段 and 再給一句 under today's line, both pointing at it", async () => {
      await handlePostback('user1', 'token1', 'action=daily_line', MORNING)

      const { index } = todaysLine(MORNING)
      expect(buttonsOf(mockReplyAndRemember.mock.calls[0])).toEqual([
        { label: '多了解這一段', data: `action=daily_line_more&line=${index}` },
        { label: '再給一句', data: `action=daily_line_next&line=${index}` },
      ])
    })

    it('再給一句 brings the next line in the sutra\'s order, with the buttons again', async () => {
      await handlePostback('user1', 'token1', 'action=daily_line_next&line=5', MORNING)

      const call = mockReplyAndRemember.mock.calls[0]
      expect(call[2]).toBe('（按了「再給一句」）')
      expect(call[3]).toContain(`「${DAILY_LINES[6][0]}」`)
      expect(call[3]).not.toMatch(/^每日一句/)
      expect(buttonsOf(call).map((b) => b.data)).toEqual(['action=daily_line_more&line=6', 'action=daily_line_next&line=6'])
    })

    it('starts again from the first line after the last', async () => {
      await handlePostback('user1', 'token1', `action=daily_line_next&line=${DAILY_LINES.length - 1}`, MORNING)

      expect(mockReplyAndRemember.mock.calls[0][3]).toContain(`「${DAILY_LINES[0][0]}」`)
    })

    it('多了解這一段 shows the whole chapter, then asks the model about that line', async () => {
      await handlePostback('user1', 'token1', 'action=daily_line_more&line=17', MORNING)

      const [userId, replyToken, asked, sentAt, { before }] = mockHandleText.mock.calls[0]
      expect([userId, replyToken, sentAt]).toEqual(['user1', 'token1', MORNING])
      expect(asked).toContain(`「${DAILY_LINES[17][0]}」`)
      expect(before).toMatch(/^〈一體同觀分第十八〉原文：\n\n/)
      expect(before).toContain('過去心不可得，現在心不可得，未來心不可得。')
      expect(mockReplyAndRemember).not.toHaveBeenCalled()
    })

    it.each(['action=daily_line_next&line=abc', 'action=daily_line_next&line=999', 'action=daily_line_next'])(
      'goes on from today\'s line when it cannot tell which line the button was under (%s)',
      async (data) => {
        await handlePostback('user1', 'token1', data, MORNING)

        const next = DAILY_LINES[(todaysLine(MORNING).index + 1) % DAILY_LINES.length][0]
        expect(mockReplyAndRemember.mock.calls[0][3]).toContain(`「${next}」`)
      },
    )
  })

  it('recognises only the exact menu texts as commands', () => {
    expect(['@隨意聊聊', '@每日一句', '@清除記憶', '@關於'].every(isCommand)).toBe(true)
    expect(isCommand('@_@ 今天好累')).toBe(false)
    expect(isCommand('@關於 你是誰')).toBe(false)
    expect(isCommand('toString')).toBe(false)
  })

})
