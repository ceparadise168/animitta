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
const mockGetContext = jest.fn()
jest.unstable_mockModule('../lambda/services/memory.mjs', () => ({
  clearMemory: mockClearMemory,
  getContext: mockGetContext,
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
const { DAILY_LINES, lineAt, lineReply, todaysLine } = await import('../lambda/sutra.mjs')

const remembering = (recentTurns, previousSession = null) => ({ summary: null, recentTurns, previousSession })
// The turns the bot remembers from these calls, as the handlers made them.
const turnsOf = (...calls) =>
  calls.flatMap(([, , userSide, reply]) => [
    { role: 'user', content: userSide },
    { role: 'assistant', content: reply },
  ])

describe('commands', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReplyMessage.mockResolvedValue(undefined)
    mockReplyWithQuickReply.mockResolvedValue(undefined)
    mockClearMemory.mockResolvedValue(undefined)
    mockGetContext.mockResolvedValue(remembering([]))
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
        { label: '多了解這一段', data: `action=daily_line_more&line=${index}`, inputOption: 'openKeyboard' },
        { label: '再給一句', data: `action=daily_line_next&line=${index}`, inputOption: 'openKeyboard' },
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

    it('多了解這一段 puts 再給一句 alone under the explanation, reading on from that line', async () => {
      await handlePostback('user1', 'token1', 'action=daily_line_more&line=17', MORNING)

      expect(mockHandleText.mock.calls[0][4].quickReply).toEqual([{ label: '再給一句', data: 'action=daily_line_next&line=17', inputOption: 'openKeyboard' }])
    })

    it('多了解這一段 leaves out a chapter it already showed, and still asks about the line', async () => {
      await handlePostback('user1', 'token1', 'action=daily_line_more&line=19', MORNING)
      const [, , asked, , { before }] = mockHandleText.mock.calls[0]
      mockGetContext.mockResolvedValue(
        remembering([
          { role: 'user', content: asked },
          { role: 'assistant', content: `${before}\n\n（模型的解釋）` },
        ]),
      )

      await handlePostback('user1', 'token1', 'action=daily_line_more&line=20', MORNING)
      await handlePostback('user1', 'token1', 'action=daily_line_more&line=18', MORNING)

      const [sameChapter, otherChapter] = mockHandleText.mock.calls.slice(1)
      expect(sameChapter[2]).toContain(`「${DAILY_LINES[20][0]}」`)
      expect(sameChapter[4]).toEqual({ quickReply: [{ label: '再給一句', data: 'action=daily_line_next&line=20', inputOption: 'openKeyboard' }] })
      expect(otherChapter[4].before).toMatch(/^〈非說所說分第二十一〉原文：/)
    })

    it('多了解這一段 still shows the chapter when memory cannot be read, and leaves the failure to the answer', async () => {
      mockGetContext.mockRejectedValue(Object.assign(new Error('Rate exceeded'), { name: 'ProvisionedThroughputExceededException' }))
      jest.spyOn(console, 'warn').mockImplementation(() => {})

      await handlePostback('user1', 'token1', 'action=daily_line_more&line=19', MORNING)

      expect(mockHandleText.mock.calls[0][4].before).toMatch(/^〈淨心行善分第二十三〉原文：/)
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

  describe('每日一句 pressed again', () => {
    const NIGHT = Date.parse('2026-11-25T22:11:00+08:00')
    const today = todaysLine(NIGHT)
    const press = async (data, sentAt = NIGHT) => {
      await handlePostback('user1', 'token1', data, sentAt)
      return mockReplyAndRemember.mock.calls.at(-1)
    }

    it("reads on from today's line instead of showing it again", async () => {
      const first = await press('action=daily_line')
      mockGetContext.mockResolvedValue(remembering(turnsOf(first)))

      const again = await press('action=daily_line')

      expect(first[3]).toBe(lineReply(today, { first: true }))
      expect(again[2]).toBe('（按了選單的「每日一句」）')
      expect(again[3]).toBe(lineReply(lineAt(today.index + 1)))
      expect(again[5].quickReply.map((b) => b.data)).toEqual([
        `action=daily_line_more&line=${today.index + 1}`,
        `action=daily_line_next&line=${today.index + 1}`,
      ])
    })

    it('reads on from the last line shown, after 再給一句 and 多了解這一段', async () => {
      const first = await press('action=daily_line')
      mockGetContext.mockResolvedValue(remembering(turnsOf(first)))
      const next = await press(`action=daily_line_next&line=${today.index}`)
      const explained = [
        { role: 'user', content: '想多了解這一句：…' },
        { role: 'assistant', content: '（模型的解釋）' },
      ]
      mockGetContext.mockResolvedValue(remembering([...turnsOf(first, next), ...explained]))

      const again = await press('action=daily_line')

      expect(again[3]).toBe(lineReply(lineAt(today.index + 2)))
    })

    const HOUR = 3_600_000
    const sessionEnded = (endedAt, ...calls) => ({
      turns: turnsOf(...calls),
      idleMs: NIGHT - endedAt,
      endsAt: new Date(endedAt).toISOString(),
    })

    it("reads on after a break, from a session before that ended today", async () => {
      const first = await press('action=daily_line', NIGHT - 3 * HOUR)
      mockGetContext.mockResolvedValue(remembering([], sessionEnded(NIGHT - 3 * HOUR, first)))

      const again = await press('action=daily_line')

      expect(again[3]).toBe(lineReply(lineAt(today.index + 1)))
    })

    // The first reply after a break folds the session before, today's line
    // with it, into the summary (2026-11-25 review: presses went 20, 19, 20).
    it("keeps going forward once today's line is folded away", async () => {
      const first = await press('action=daily_line', NIGHT - 3 * HOUR)
      mockGetContext.mockResolvedValue(remembering([], sessionEnded(NIGHT - 3 * HOUR, first)))
      const afterBreak = await press('action=daily_line')
      mockGetContext.mockResolvedValue(remembering(turnsOf(afterBreak)))

      const again = await press('action=daily_line')

      expect(again[3]).toBe(lineReply(lineAt(today.index + 2)))
    })

    it('never brings back a line still remembered, even one an old 再給一句 showed', async () => {
      const first = await press('action=daily_line')
      mockGetContext.mockResolvedValue(remembering(turnsOf(first)))
      const old = await press(`action=daily_line_next&line=${today.index - 2}`)
      mockGetContext.mockResolvedValue(remembering(turnsOf(first, old)))

      const again = await press('action=daily_line')

      expect(old[3]).toBe(lineReply(lineAt(today.index - 1)))
      expect(again[3]).toBe(lineReply(lineAt(today.index + 1)))
    })

    it("starts a new day with that day's line, after the day before's reading", async () => {
      const yesterday = await press('action=daily_line', NIGHT - 24 * HOUR)
      mockGetContext.mockResolvedValue(remembering([], sessionEnded(NIGHT - 24 * HOUR, yesterday)))

      const tonight = await press('action=daily_line')

      expect(tonight[3]).toBe(lineReply(today, { first: true }))
    })

    it("skips today's line when it was read ahead the day before", async () => {
      const yesterday = await press('action=daily_line', NIGHT - 24 * HOUR)
      mockGetContext.mockResolvedValue(remembering(turnsOf(yesterday)))
      const ahead = await press(`action=daily_line_next&line=${today.index - 1}`, NIGHT - 24 * HOUR)
      mockGetContext.mockResolvedValue(remembering([], sessionEnded(NIGHT - 24 * HOUR, yesterday, ahead)))

      const tonight = await press('action=daily_line')

      expect(ahead[3]).toBe(lineReply(today))
      expect(tonight[3]).toBe(lineReply(lineAt(today.index + 1)))
    })

    it('starts at the day\'s line after weeks away, not where the reading stopped then', async () => {
      const longAgo = NIGHT - 15 * 24 * HOUR
      const then = await press('action=daily_line', longAgo)
      mockGetContext.mockResolvedValue(remembering(turnsOf(then)))
      const next = await press(`action=daily_line_next&line=${todaysLine(longAgo).index}`, longAgo)
      mockGetContext.mockResolvedValue(remembering([], sessionEnded(longAgo, then, next)))

      const tonight = await press('action=daily_line')

      expect(tonight[3]).toBe(lineReply(today, { first: true }))
    })

    it("still shows the day's line when memory cannot be read", async () => {
      mockGetContext.mockRejectedValue(Object.assign(new Error('Rate exceeded'), { name: 'ProvisionedThroughputExceededException' }))
      jest.spyOn(console, 'warn').mockImplementation(() => {})

      const line = await press('action=daily_line')

      expect(line[3]).toBe(lineReply(today, { first: true }))
    })
  })

  it('recognises only the exact menu texts as commands', () => {
    expect(['@隨意聊聊', '@每日一句', '@清除記憶', '@關於'].every(isCommand)).toBe(true)
    expect(isCommand('@_@ 今天好累')).toBe(false)
    expect(isCommand('@關於 你是誰')).toBe(false)
    expect(isCommand('toString')).toBe(false)
  })

})
