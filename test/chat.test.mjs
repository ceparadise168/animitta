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
const mockDownloadContent = jest.fn()
const mockReplyWithQuickReplyMessage = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  replyMessage: mockReplyMessage,
  replyWithQuickReplyMessage: mockReplyWithQuickReplyMessage,
  downloadContent: mockDownloadContent,
  verifySignature: jest.fn(),
  showLoadingIndicator: jest.fn().mockResolvedValue(undefined),
}))

const { handleText, handleAudio } = await import(
  '../lambda/services/chat.mjs'
)

describe('chat service', () => {
  const mockProvider = {
    chatCompletion: jest.fn(),
    transcribeAudio: jest.fn(),
    summarize: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetProvider.mockReturnValue(mockProvider)
    mockGetContext.mockResolvedValue({ summary: null, recentTurns: [] })
    mockSaveTurn.mockResolvedValue(undefined)
    mockCompressOldTurns.mockResolvedValue(undefined)
    mockReplyMessage.mockResolvedValue(undefined)
    mockReplyWithQuickReplyMessage.mockResolvedValue(undefined)
  })

  describe('handleText', () => {
    it('replies with plain message when no suggestions', async () => {
      mockProvider.chatCompletion.mockResolvedValue({
        text: '佛曰：**放下**吧',
        suggestions: [],
      })

      await handleText('user1', 'token1', '我好累')

      expect(mockGetContext).toHaveBeenCalledWith('user1')
      expect(mockProvider.chatCompletion).toHaveBeenCalled()
      expect(mockReplyMessage).toHaveBeenCalledWith('token1', '佛曰：放下吧')
      expect(mockSaveTurn).toHaveBeenCalledWith('user1', '我好累', '佛曰：放下吧')
      expect(mockCompressOldTurns).toHaveBeenCalledWith('user1', mockProvider)
    })

    it('replies with quick reply buttons when suggestions present', async () => {
      mockProvider.chatCompletion.mockResolvedValue({
        text: '金剛經核心有幾個方向',
        suggestions: ['空性', '無我', '無住'],
      })

      await handleText('user1', 'token1', '金剛經核心思想')

      expect(mockReplyWithQuickReplyMessage).toHaveBeenCalledWith(
        'token1',
        '金剛經核心有幾個方向',
        [
          { label: '空性', text: '空性' },
          { label: '無我', text: '無我' },
          { label: '無住', text: '無住' },
        ]
      )
      expect(mockReplyMessage).not.toHaveBeenCalled()
    })

    it('keeps quick reply labels within LINE limits while preserving full text', async () => {
      const longSuggestion = '這是一個超過二十個字很多很多的建議選項應該被截短'
      mockProvider.chatCompletion.mockResolvedValue({
        text: '可以從這裡開始',
        suggestions: [longSuggestion],
      })

      await handleText('user1', 'token1', '我想聊聊')

      const items = mockReplyWithQuickReplyMessage.mock.calls[0][2]
      expect(items[0].label.length).toBeLessThanOrEqual(20)
      expect(items[0].text).toBe(longSuggestion)
    })
  })

  describe('handleAudio', () => {
    it('downloads audio, transcribes, then handles as text', async () => {
      const audioBuffer = new ArrayBuffer(8)
      mockDownloadContent.mockResolvedValue(audioBuffer)
      mockProvider.transcribeAudio.mockResolvedValue('語音內容')
      mockProvider.chatCompletion.mockResolvedValue({ text: '回覆', suggestions: [] })

      await handleAudio('user1', 'token1', 'msg123')

      expect(mockDownloadContent).toHaveBeenCalledWith('msg123')
      expect(mockProvider.transcribeAudio).toHaveBeenCalledWith(audioBuffer)
      expect(mockProvider.chatCompletion).toHaveBeenCalled()
      expect(mockReplyMessage).toHaveBeenCalledWith('token1', '回覆')
    })
  })
})
