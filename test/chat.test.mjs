import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
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

    describe('which model answers', () => {
      const SORTS = '你在替一個聊天機器人分派訊息'
      // The provider has a model for worries, and its chat model sorts the talk as `kind`.
      const sortingAs = (kind) => {
        mockProvider.answersWorries = true
        mockProvider.ask = jest.fn(async (question) => {
          if (!question.startsWith(SORTS)) throw new Error('not asked to judge a closing sentence here')
          if (kind instanceof Error) throw kind
          return kind
        })
        mockProvider.chatCompletion.mockResolvedValue({ text: '嗯，聽起來不容易' })
      }
      const asked = (call = 0) => ({
        prompt: mockProvider.chatCompletion.mock.calls[call][0][0].content,
        worries: mockProvider.chatCompletion.mock.calls[call][1].worries,
      })

      afterEach(() => {
        delete mockProvider.answersWorries
        delete mockProvider.ask
      })

      it('gives worries to the model kept for them, with the prompt written for it', async () => {
        sortingAs('C')

        await handleText('user1', 'token1', '最近跟身邊的人都有點疏遠', Date.now())

        expect(asked().worries).toBe(true)
        expect(asked().prompt).toContain('<校準 — 你容易退得太後面>')
        expect(mockReplyMessage).toHaveBeenCalledWith('token1', '嗯，聽起來不容易')
      })

      it.each([['small talk', 'A'], ['a question about the sutra', 'B']])('leaves %s with the chat model and its own prompt', async (_, kind) => {
        sortingAs(kind)

        await handleText('user1', 'token1', '欸 今天天氣有夠好', 1795270000000)

        expect(asked().worries).toBe(false)
        expect(asked().prompt).not.toContain('校準')
      })

      it('sorts with the last turns in view, so a short reply stays with what it answers', async () => {
        sortingAs('C')
        mockGetContext.mockResolvedValue({
          summary: null,
          previousSession: null,
          recentTurns: [
            { role: 'user', content: '最近跟身邊的人都有點疏遠' },
            { role: 'assistant', content: '這樣多久了' },
          ],
        })

        await handleText('user1', 'token1', '對啊', 1795270000000)

        const question = mockProvider.ask.mock.calls[0][0]
        expect(question).toContain('使用者：最近跟身邊的人都有點疏遠\n無相界：這樣多久了')
        expect(question).toMatch(/最新一則：對啊$/)
      })

      it('lets the chat model answer when the talk could not be sorted', async () => {
        sortingAs(new Error('Anthropic ask failed: 529 overloaded_error'))
        jest.spyOn(console, 'warn').mockImplementation(() => {})

        await handleText('user1', 'token1', '最近跟身邊的人都有點疏遠', 1795270000000)

        expect(asked().worries).toBe(false)
        expect(mockReplyMessage).toHaveBeenCalledWith('token1', '嗯，聽起來不容易')
      })

      it('does not sort when the caller already knows, or when there is one model only', async () => {
        sortingAs('C')
        await handleText('user1', 'token1', '想多了解這一句', 1795270000000, { worries: false })
        expect(mockProvider.ask).not.toHaveBeenCalled()
        expect(asked().worries).toBe(false)

        mockProvider.answersWorries = false
        await handleText('user1', 'token1', '最近跟身邊的人都有點疏遠', 1795270000000)
        expect(mockProvider.ask).not.toHaveBeenCalled()
        expect(asked(1).worries).toBe(false)
      })

      it('has the chat model answer when the model for worries cannot', async () => {
        sortingAs('C')
        mockProvider.chatCompletion
          .mockRejectedValueOnce(new Error('Anthropic chat refused: general_harms'))
          .mockResolvedValueOnce({ text: '嗯，我在聽' })
        jest.spyOn(console, 'warn').mockImplementation(() => {})

        await handleText('user1', 'token1', '最近跟身邊的人都有點疏遠', Date.now())

        expect([asked(0).worries, asked(1).worries]).toEqual([true, false])
        expect(asked(1).prompt).not.toContain('校準')
        expect(mockReplyMessage).toHaveBeenCalledWith('token1', '嗯，我在聽')
      })

      it('goes straight to the chat model when too little time is left for two tries', async () => {
        sortingAs('C')

        await handleText('user1', 'token1', '最近跟身邊的人都有點疏遠', Date.now() - 50_000)

        expect(mockProvider.chatCompletion).toHaveBeenCalledTimes(1)
        expect(asked().worries).toBe(false)
      })
    })

    describe("a reply that carries the model's notes to itself", () => {
      it('is asked for once more, and the clean one is sent', async () => {
        mockProvider.chatCompletion
          .mockResolvedValueOnce({ text: '<reasoning>The conversation is circling…</reasoning>嗯，提不起勁' })
          .mockResolvedValueOnce({ text: '嗯，提不起勁' })
        jest.spyOn(console, 'warn').mockImplementation(() => {})

        await handleText('user1', 'token1', '就是提不起勁', 1795270000000)

        expect(mockReplyMessage).toHaveBeenCalledWith('token1', '嗯，提不起勁')
        expect(mockSaveTurn).toHaveBeenCalledWith('user1', '就是提不起勁', '嗯，提不起勁', 1795270000000)
      })

      it('is never sent: after a second one the person gets the apology instead', async () => {
        mockProvider.chatCompletion.mockResolvedValue({ text: '<invoke name="x">\n</invoke>\n嗯' })
        jest.spyOn(console, 'warn').mockImplementation(() => {})

        await expect(handleText('user1', 'token1', '就是提不起勁', 1795270000000)).rejects.toThrow("the reply carried the model's notes to itself")

        expect(mockReplyMessage).not.toHaveBeenCalled()
      })
    })

    // Replies the model wrote for made-up conversations (2026-11-25).
    describe('a closing question that offers two choices', () => {
      const JUDGES = '下面是一則聊天回覆的最後一句'
      const judgedAs = (answer) => {
        mockProvider.ask = jest.fn(async (question) => {
          if (!question.startsWith(JUDGES)) throw new Error('not asked to sort the talk here')
          if (answer instanceof Error) throw answer
          return answer
        })
      }
      const sentFor = async (modelText, userText = '最近跟身邊的人都有點疏遠') => {
        mockProvider.chatCompletion.mockResolvedValue({ text: modelText })
        await handleText('user1', 'token1', userText, 1795270000000)
        return mockReplyMessage.mock.calls.at(-1)[1]
      }
      const judged = () => mockProvider.ask.mock.calls.map(([question]) => question.match(/最後一句：「([\s\S]*)」$/)[1])

      afterEach(() => {
        delete mockProvider.ask
      })

      it.each([
        ['疏遠是什麼感覺\n\n是他們變了，還是你發現自己講不出話了；或是根本沒特別原因，就是有點卡著', '疏遠是什麼感覺'],
        ['嗯，提不起勁。\n\n這個狀態有多久了？是最近幾週，還是已經一段時間？', '嗯，提不起勁。\n\n這個狀態有多久了？'],
        ['那就難熬了\n\n窗戶看得到外面嗎，還是被困在裡面', '那就難熬了'],
      ])('is left off when the chat model takes it for one: %j', async (written, sent) => {
        judgedAs('是')

        expect(await sentFor(written)).toBe(sent)
      })

      it('is left out of what the bot remembers saying, too', async () => {
        judgedAs('是')

        await sentFor('那就難熬了\n\n窗戶看得到外面嗎，還是被困在裡面', '哈哈對啊')

        expect(mockSaveTurn).toHaveBeenCalledWith('user1', '哈哈對啊', '那就難熬了', 1795270000000)
      })

      it('goes with the question it carries on, when that one only offered the first choice', async () => {
        judgedAs('是')

        expect(await sentFor('嗯，那個循環感\n\n你會這樣問，是今天特別悶？還是說最近發生了什麼事？')).toBe('嗯，那個循環感')
        expect(judged()).toEqual(['你會這樣問，是今天特別悶？還是說最近發生了什麼事？'])
      })

      it('leaves an open question before it in place', async () => {
        judgedAs('是')

        expect(await sentFor('嗯\n\n那個卡的感覺，是什麼時候開始的？還是說，它一直都在，只是最近特別明顯？')).toBe('嗯\n\n那個卡的感覺，是什麼時候開始的？')
        expect(judged()).toEqual(['還是說，它一直都在，只是最近特別明顯？'])
      })

      it.each([
        ['還是 as "had better"', '累成這樣\n\n今天還是先休息吧'],
        ['還是 as "still"', '這是正常的\n\n可是今天還是下雨'],
        ['handing the direction back', '現在先不急著怎麼解開它。你想講講，這個「卡」具體長什麼樣子嗎？還是先停在這裡也可以。'],
      ])('stays when the chat model does not take it for one: %s', async (_, written) => {
        judgedAs('否')

        expect(await sentFor(written)).toBe(written)
      })

      it('stays when the chat model could not be asked', async () => {
        judgedAs(new Error('Anthropic ask failed: 529 overloaded_error'))
        jest.spyOn(console, 'warn').mockImplementation(() => {})
        const written = '那就難熬了\n\n窗戶看得到外面嗎，還是被困在裡面'

        expect(await sentFor(written)).toBe(written)
      })

      it.each([
        ['a reply with no 還是 in its closing sentence', '是工作的事，還是家裡的事，你剛剛沒說\n\n不過不急，慢慢講'],
        ['a reply that would have almost nothing left', '嗯\n\n是他們變了，還是你變了'],
      ])('is not even asked about for %s', async (_, written) => {
        judgedAs('是')

        expect(await sentFor(written)).toBe(written)
        expect(mockProvider.ask).not.toHaveBeenCalled()
      })

      it.each([
        ['what the person just said', '考試考爛了 我想死啦 哈哈', [], '考爛了喔\n\n你說想死，是氣話，還是心裡真的有冒出這種念頭？'],
        ['a way of saying it the list of words would miss', '我想去死', [], '我有看到\n\n你是今天特別難受，還是這樣想有一陣子了？'],
        ['the reply itself', '就是提不起勁', [], '嗯，提不起勁\n\n你說的累，是身體累，還是有時候會覺得不想活了？'],
        ['what the person said two turns ago', '也還好啦 就很累', [{ role: 'user', content: '有時候會想，如果我消失了大家會不會比較輕鬆' }, { role: 'assistant', content: '這句我有看到' }], '嗯\n\n這個累，是今天特別累，還是已經一陣子了？'],
      ])('stays, unasked, when the talk is near a crisis in %s', async (_, userText, recentTurns, written) => {
        judgedAs('是')
        mockGetContext.mockResolvedValue({ summary: null, previousSession: null, recentTurns })

        expect(await sentFor(written, userText)).toBe(written)
        expect(mockProvider.ask).not.toHaveBeenCalled()
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
