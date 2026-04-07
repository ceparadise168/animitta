import { describe, it, expect, jest, beforeEach } from '@jest/globals'

process.env.MEMORY_TABLE_NAME = 'test-table'
process.env.MAX_RECENT_TURNS = '5'
process.env.CONVERSATION_TTL_DAYS = '30'

const mockSend = jest.fn()
jest.unstable_mockModule('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  QueryCommand: jest.fn((params) => ({ ...params, _type: 'Query' })),
  GetItemCommand: jest.fn((params) => ({ ...params, _type: 'GetItem' })),
  PutItemCommand: jest.fn((params) => ({ ...params, _type: 'PutItem' })),
  BatchWriteItemCommand: jest.fn((params) => ({
    ...params,
    _type: 'BatchWrite',
  })),
}))

const { getContext, saveTurn } = await import(
  '../lambda/services/memory.mjs'
)

describe('memory service', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  describe('getContext', () => {
    it('returns empty context when no data exists', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] })
      mockSend.mockResolvedValueOnce({})

      const ctx = await getContext('user123')

      expect(ctx.summary).toBeNull()
      expect(ctx.recentTurns).toEqual([])
    })

    it('returns recent turns and summary', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { sk: { S: 'TURN#2026-01-01T00:00:00Z#user' }, content: { S: '你好' }, role: { S: 'user' } },
          { sk: { S: 'TURN#2026-01-01T00:00:00Z#asst' }, content: { S: '嗨' }, role: { S: 'assistant' } },
        ],
      })
      mockSend.mockResolvedValueOnce({
        Item: { content: { S: '之前聊了工作壓力' } },
      })

      const ctx = await getContext('user123')

      expect(ctx.summary).toBe('之前聊了工作壓力')
      expect(ctx.recentTurns).toEqual([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '嗨' },
      ])
    })
  })

  describe('saveTurn', () => {
    it('writes two items (user + assistant) to DynamoDB', async () => {
      mockSend.mockResolvedValue({})

      await saveTurn('user123', '你好', '嗨～')

      expect(mockSend).toHaveBeenCalledTimes(2)
    })
  })
})
