import { describe, it, expect, jest, beforeEach } from '@jest/globals'
import { format } from 'node:util'

const mockGetContext = jest.fn()
const mockSaveTurn = jest.fn()
const mockCompressOldTurns = jest.fn()
const mockArchiveSession = jest.fn()
jest.unstable_mockModule('../lambda/services/memory.mjs', () => ({
  getContext: mockGetContext,
  saveTurn: mockSaveTurn,
  compressOldTurns: mockCompressOldTurns,
  archiveSession: mockArchiveSession,
}))

const mockGetProvider = jest.fn()
jest.unstable_mockModule('../lambda/providers/index.mjs', () => ({
  getProvider: mockGetProvider,
}))

const mockReplyMessage = jest.fn()
const mockReplyWithQuickReply = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  replyMessage: mockReplyMessage,
  replyWithQuickReply: mockReplyWithQuickReply,
  verifySignature: jest.fn(),
  showLoadingIndicator: jest.fn().mockResolvedValue(undefined),
}))

const { handleText, replyAndRemember } = await import('../lambda/services/chat.mjs')

describe('chat service', () => {
  const mockProvider = {
    chatCompletion: jest.fn(),
    summarize: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetProvider.mockReturnValue(mockProvider)
    mockGetContext.mockResolvedValue({ summary: null, recentTurns: [], previousSession: null })
    mockSaveTurn.mockResolvedValue(true)
    mockCompressOldTurns.mockResolvedValue(undefined)
    mockReplyMessage.mockResolvedValue(undefined)
  })

  describe('handleText', () => {
    it('replies with the model text stripped of markdown and remembers the turn', async () => {
      mockProvider.chatCompletion.mockResolvedValue({ text: '佛曰：**放下**吧' })

      await handleText('user1', 'token1', '我好累', 1795270000000)

      expect(mockGetContext).toHaveBeenCalledWith('user1')
      expect(mockProvider.chatCompletion).toHaveBeenCalled()
      expect(mockReplyMessage).toHaveBeenCalledWith('token1', '佛曰：放下吧')
      expect(mockSaveTurn).toHaveBeenCalledWith('user1', '我好累', '佛曰：放下吧', 1795270000000)
      expect(mockCompressOldTurns).toHaveBeenCalledWith('user1', mockProvider)
    })

    // Replies the model wrote for made-up conversations (2026-11-25), and what the person should get.
    describe('a closing question that offers two choices', () => {
      const sentFor = async (modelText, userText = '最近跟身邊的人都有點疏遠') => {
        mockProvider.chatCompletion.mockResolvedValue({ text: modelText })
        await handleText('user1', 'token1', userText, 1795270000000)
        return mockReplyMessage.mock.calls.at(-1)[1]
      }

      it.each([
        ['疏遠是什麼感覺啦\n\n是他們變了，還是你發現自己講不出話了；或是根本沒特別原因，就是有點卡著', '疏遠是什麼感覺啦'],
        ['嗯，提不起勁。\n\n這個狀態有多久了？是最近幾週，還是已經一段時間？', '嗯，提不起勁。\n\n這個狀態有多久了？'],
        ['哈那就難熬了\n\n窗戶看得到外面嗎，還是被困在裡面', '哈那就難熬了'],
        ['嗯\n\n那個卡的感覺，是什麼時候開始的？還是說，它一直都在，只是最近特別明顯？', '嗯\n\n那個卡的感覺，是什麼時候開始的？'],
        ['累爆喔\n\n這種加班累，是身體累還是心裡更累啦', '累爆喔'],
      ])('is left off: %j', async (written, sent) => {
        expect(await sentFor(written)).toBe(sent)
      })

      it('is left out of what the bot remembers saying, too', async () => {
        await sentFor('哈那就難熬了\n\n窗戶看得到外面嗎，還是被困在裡面', '哈哈對啊')

        expect(mockSaveTurn).toHaveBeenCalledWith('user1', '哈哈對啊', '哈那就難熬了', 1795270000000)
      })

      it.each([
        ['handing the direction back', '現在先不急著怎麼解開它。你想講講，這個「卡」具體長什麼樣子嗎？還是先停在這裡也可以。'],
        ['還是 as "still"', '嗯\n\n那就更孤獨一點了。試過了，還是講不通'],
        ['還是 as "still", after the person', '像你可以全力去做一件事，同時心裡知道「結果會怎樣，我還是我」'],
        ['a reply that is nothing else', '是他們變了，還是你變了'],
        ['a choice that is not the closing sentence', '是工作的事，還是家裡的事，你剛剛沒說\n\n不過不急，慢慢講'],
        ['an open question', '嗯，那種感覺滿難受的\n\n這樣多久了'],
      ])('stays for %s', async (_, written) => {
        expect(await sentFor(written)).toBe(written)
      })

      it.each([
        ['考試考爛了 我想死啦 哈哈', '我看到你說「想死」。你現在是真的有點想不開，還是單純在罵自己考得爛？'],
        ['有時候會想，如果我消失了大家會不會比較輕鬆', '聽起來這個念頭在你心裡盤旋了一陣子。\n\n真的是這樣嗎，還是有什麼具體的事讓你這樣想？'],
        ['就是提不起勁', '嗯，提不起勁\n\n你說的累，是身體累，還是有時候會覺得不想活了？'],
      ])('stays when the talk is near a crisis: %s', async (userText, written) => {
        expect(await sentFor(written, userText)).toBe(written)
      })
    })

    it('gives the model until 55 seconds after the user sent the message, while LINE can still take the reply', async () => {
      mockProvider.chatCompletion.mockResolvedValue({ text: '嗯' })

      await handleText('user1', 'token1', '我好累', Date.now())

      const { signal } = mockProvider.chatCompletion.mock.calls[0][1]
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
    })

    it('keeps the typing animation up for the whole wait, since the answer may take 55 seconds', async () => {
      const { showLoadingIndicator } = await import('../lambda/line.mjs')
      mockProvider.chatCompletion.mockResolvedValue({ text: '嗯' })

      await handleText('user1', 'token1', '我好累', Date.now())

      expect(showLoadingIndicator).toHaveBeenCalledWith('user1', 60)
    })

    it('fails instead of waiting when the model is still writing at the deadline', async () => {
      mockProvider.chatCompletion.mockImplementation(
        (messages, { signal }) =>
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
      )

      // Sent 54 seconds ago: the model gets the 5-second minimum.
      const startedAt = performance.now()
      await expect(handleText('user1', 'token1', '我好累', Date.now() - 54_000)).rejects.toThrow()

      expect(performance.now() - startedAt).toBeLessThan(6_500)
      expect(mockReplyMessage).not.toHaveBeenCalled()
    }, 10_000)

    it('says when the reply has reached LINE, before remembering the exchange', async () => {
      mockProvider.chatCompletion.mockResolvedValue({ text: '嗯' })
      const order = []
      mockReplyMessage.mockImplementation(async () => order.push('reply'))
      mockSaveTurn.mockImplementation(async () => (order.push('save'), true))

      await handleText('user1', 'token1', '我好累', Date.now(), { onReplied: () => order.push('replied') })

      expect(order).toEqual(['reply', 'replied', 'save'])
    })

    it('writes summaries only after the reply reached LINE, as the alert email tells Eric', async () => {
      mockProvider.chatCompletion.mockResolvedValue({ text: '嗯' })
      mockGetContext.mockResolvedValueOnce({
        summary: null,
        recentTurns: [],
        previousSession: { turns: [{ role: 'user', content: '昨天好累' }], idleMs: 3 * 3_600_000, endsAt: '2026-11-25T08:00:00.000Z' },
      })
      const order = []
      mockReplyMessage.mockImplementation(async () => order.push('reply'))
      mockArchiveSession.mockImplementationOnce(async () => order.push('archive'))
      mockCompressOldTurns.mockImplementation(async () => order.push('compress'))

      await handleText('user1', 'token1', '我好累', Date.now())

      expect(order).toEqual(['reply', 'archive', 'compress'])
    })

    it('does not say the reply reached LINE when sending it failed', async () => {
      mockProvider.chatCompletion.mockResolvedValue({ text: '嗯' })
      mockReplyMessage.mockRejectedValue(new Error('LINE reply failed: 400'))
      const onReplied = jest.fn()

      await expect(handleText('user1', 'token1', '我好累', Date.now(), { onReplied })).rejects.toThrow('LINE reply failed')

      expect(onReplied).not.toHaveBeenCalled()
    })

    it('sends a fixed message ahead of the answer when asked, and remembers both', async () => {
      mockProvider.chatCompletion.mockResolvedValue({ text: '這段在講心抓不住' })

      await handleText('user1', 'token1', '想多了解這一句', 1795270000000, { before: '〈一體同觀分第十八〉原文：…' })

      expect(mockReplyMessage).toHaveBeenCalledWith('token1', ['〈一體同觀分第十八〉原文：…', '這段在講心抓不住'])
      expect(mockSaveTurn).toHaveBeenCalledWith('user1', '想多了解這一句', '〈一體同觀分第十八〉原文：…\n\n這段在講心抓不住', 1795270000000)
    })

    it('says which words went unanswered when the model fails', async () => {
      mockProvider.chatCompletion.mockRejectedValue(new Error('Anthropic chat failed: 529'))

      await expect(handleText('user1', 'token1', '我真的不想活了', Date.now())).rejects.toMatchObject({
        message: 'Anthropic chat failed: 529',
        unanswered: '我真的不想活了',
      })
      expect(mockSaveTurn).not.toHaveBeenCalled()
    })

    it.each([
      ['a frozen error', Object.freeze(new Error('frozen'))],
      ['a thrown string', 'boom'],
    ])('still says which words went unanswered after %s', async (_, thrown) => {
      mockProvider.chatCompletion.mockRejectedValue(thrown)

      await expect(handleText('user1', 'token1', '我真的不想活了', Date.now())).rejects.toMatchObject({
        unanswered: '我真的不想活了',
        cause: thrown,
      })
    })

    it.each([
      ['an error', new Error('Anthropic chat failed: 529'), 'Anthropic chat failed: 529'],
      ['a frozen error', Object.freeze(new Error('frozen')), 'frozen'],
      ['a thrown string', 'boom', 'boom'],
    ])('keeps what the person said out of the error log after %s', async (_, thrown, failure) => {
      mockProvider.chatCompletion.mockRejectedValue(thrown)

      const err = await handleText('user1', 'token1', '我真的不想活了', Date.now()).catch((e) => e)
      const logLine = format('Handler error:', err)

      expect(logLine).toContain(failure)
      expect(logLine).not.toContain('我真的不想活了')
    })
  })

  describe('replyAndRemember', () => {
    it('puts buttons under the message when asked, and remembers the exchange', async () => {
      mockReplyWithQuickReply.mockResolvedValue(undefined)
      const buttons = [{ label: '再給一句', data: 'action=daily_line_next&line=3' }]

      await replyAndRemember('user1', 'token1', '（按了「再給一句」）', '「應無所住而生其心。」', 1795270000000, { quickReply: buttons })

      expect(mockReplyWithQuickReply).toHaveBeenCalledWith('token1', '「應無所住而生其心。」', buttons)
      expect(mockReplyMessage).not.toHaveBeenCalled()
      expect(mockSaveTurn).toHaveBeenCalledWith('user1', '（按了「再給一句」）', '「應無所住而生其心。」', 1795270000000)
    })

    it('sends a plain message when no buttons are asked for', async () => {
      await replyAndRemember('user1', 'token1', '（按了選單的「隨意聊聊」）', '嗨', 1795270000000)

      expect(mockReplyMessage).toHaveBeenCalledWith('token1', '嗨')
      expect(mockReplyWithQuickReply).not.toHaveBeenCalled()
    })

    it('writes summaries only after the reply reached LINE', async () => {
      const order = []
      mockReplyMessage.mockImplementation(async () => order.push('reply'))
      mockCompressOldTurns.mockImplementation(async () => order.push('compress'))

      await replyAndRemember('user1', 'token1', '（按了選單的「隨意聊聊」）', '嗨', 1795270000000)

      expect(order).toEqual(['reply', 'compress'])
    })
  })
})
