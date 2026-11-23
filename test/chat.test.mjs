import { describe, it, expect, jest, beforeEach } from '@jest/globals'

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
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  replyMessage: mockReplyMessage,
  verifySignature: jest.fn(),
  showLoadingIndicator: jest.fn().mockResolvedValue(undefined),
}))

const { handleText } = await import('../lambda/services/chat.mjs')

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

    it('gives the model until 55 seconds after the user sent the message, while LINE can still take the reply', async () => {
      mockProvider.chatCompletion.mockResolvedValue({ text: '嗯' })

      await handleText('user1', 'token1', '我好累', Date.now())

      const { signal } = mockProvider.chatCompletion.mock.calls[0][1]
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
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

    it('does not say the reply reached LINE when sending it failed', async () => {
      mockProvider.chatCompletion.mockResolvedValue({ text: '嗯' })
      mockReplyMessage.mockRejectedValue(new Error('LINE reply failed: 400'))
      const onReplied = jest.fn()

      await expect(handleText('user1', 'token1', '我好累', Date.now(), { onReplied })).rejects.toThrow('LINE reply failed')

      expect(onReplied).not.toHaveBeenCalled()
    })

    it('says which words went unanswered when the model fails', async () => {
      mockProvider.chatCompletion.mockRejectedValue(new Error('Anthropic chat failed: 529'))

      await expect(handleText('user1', 'token1', '我真的不想活了', Date.now())).rejects.toMatchObject({
        unanswered: '我真的不想活了',
      })
      expect(mockSaveTurn).not.toHaveBeenCalled()
    })
  })
})
