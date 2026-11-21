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
  UpdateItemCommand: jest.fn((params) => ({ ...params, _type: 'UpdateItem' })),
  TransactWriteItemsCommand: jest.fn((params) => ({ ...params, _type: 'TransactWrite' })),
  DeleteItemCommand: jest.fn((params) => ({ ...params, _type: 'DeleteItem' })),
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

    it('returns recent turns in conversation order, and the summary', async () => {
      const recent = new Date(Date.now() - 60_000).toISOString()
      const earlier = new Date(Date.now() - 120_000).toISOString()
      // What DynamoDB returns for ScanIndexForward:false. The two items of a turn
      // share a timestamp and "user" sorts after "asst", so user comes first.
      mockSend.mockResolvedValueOnce({
        Items: [
          { sk: { S: `TURN#${recent}#user` }, content: { S: '還好' }, role: { S: 'user' } },
          { sk: { S: `TURN#${recent}#asst` }, content: { S: '那就好' }, role: { S: 'assistant' } },
          { sk: { S: `TURN#${earlier}#user` }, content: { S: '你好' }, role: { S: 'user' } },
          { sk: { S: `TURN#${earlier}#asst` }, content: { S: '嗨' }, role: { S: 'assistant' } },
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
        { role: 'user', content: '還好' },
        { role: 'assistant', content: '那就好' },
      ])
    })
  })

  describe('saveTurn', () => {
    it('writes the user and bot items, each expiring CONVERSATION_TTL_DAYS from now', async () => {
      mockSend.mockResolvedValue({})

      await saveTurn('user123', '你好', '嗨～', Date.now())

      const puts = mockSend.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd._type === 'PutItem')
      expect(puts.map((cmd) => [cmd.Item.role.S, cmd.Item.content.S])).toEqual([
        ['user', '你好'],
        ['assistant', '嗨～'],
      ])
      const in30Days = Math.floor(Date.now() / 1000) + 30 * 86400
      for (const cmd of puts) expect(Number(cmd.Item.ttl.N)).toBeGreaterThanOrEqual(in30Days - 5)
    })

    it('still saves the turn when a fold is rewriting the summary at the same moment', async () => {
      mockSend.mockImplementation(async (cmd) => {
        if (cmd._type === 'UpdateItem') throw Object.assign(new Error('Transaction is ongoing for the item'), { name: 'TransactionConflictException' })
        return {}
      })

      await expect(saveTurn('user123', '你好', '嗨～', Date.now())).resolves.toBe(true)
    })

    it('still saves the turn when the user has no summary yet', async () => {
      mockSend.mockImplementation(async (cmd) => {
        if (cmd._type === 'UpdateItem') throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' })
        return {}
      })

      await expect(saveTurn('user123', '你好', '嗨～', Date.now())).resolves.toBe(true)
    })
  })
})
