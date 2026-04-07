import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const mockGetContext = jest.fn()
const mockSaveTurn = jest.fn()
const mockCompressOldTurns = jest.fn()
jest.unstable_mockModule('../lambda/services/memory.mjs', () => ({
  getContext: mockGetContext,
  saveTurn: mockSaveTurn,
  compressOldTurns: mockCompressOldTurns,
}))

const mockGetProvider = jest.fn()
jest.unstable_mockModule('../lambda/providers/index.mjs', () => ({
  getProvider: mockGetProvider,
}))

const mockReplyMessage = jest.fn()
const mockDownloadContent = jest.fn()
jest.unstable_mockModule('../lambda/line.mjs', () => ({
  replyMessage: mockReplyMessage,
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
  })

  describe('handleText', () => {
    it('gets context, calls LLM, replies, saves turn, and compresses', async () => {
      mockProvider.chatCompletion.mockResolvedValue('佛曰：**放下**吧')

      await handleText('user1', 'token1', '我好累')

      expect(mockGetContext).toHaveBeenCalledWith('user1')
      expect(mockProvider.chatCompletion).toHaveBeenCalled()
      // Should strip markdown artifacts
      expect(mockReplyMessage).toHaveBeenCalledWith('token1', '佛曰：放下吧')
      expect(mockSaveTurn).toHaveBeenCalledWith('user1', '我好累', '佛曰：放下吧')
      expect(mockCompressOldTurns).toHaveBeenCalledWith('user1', mockProvider)
    })
  })

  describe('handleAudio', () => {
    it('downloads audio, transcribes, then handles as text', async () => {
      const audioBuffer = new ArrayBuffer(8)
      mockDownloadContent.mockResolvedValue(audioBuffer)
      mockProvider.transcribeAudio.mockResolvedValue('語音內容')
      mockProvider.chatCompletion.mockResolvedValue('回覆')

      await handleAudio('user1', 'token1', 'msg123')

      expect(mockDownloadContent).toHaveBeenCalledWith('msg123')
      expect(mockProvider.transcribeAudio).toHaveBeenCalledWith(audioBuffer)
      expect(mockProvider.chatCompletion).toHaveBeenCalled()
      expect(mockReplyMessage).toHaveBeenCalledWith('token1', '回覆')
    })
  })
})
