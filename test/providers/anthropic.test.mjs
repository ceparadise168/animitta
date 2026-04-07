import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const mockFetch = jest.fn()
global.fetch = mockFetch

process.env.ANTHROPIC_API_KEY = 'test-ant-key'
process.env.OPENAI_API_KEY = 'test-oai-key'
process.env.CHAT_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001'
process.env.SUMMARY_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001'

const { AnthropicProvider } = await import(
  '../../lambda/providers/anthropic.mjs'
)

describe('AnthropicProvider', () => {
  let provider

  beforeEach(() => {
    provider = new AnthropicProvider()
    mockFetch.mockReset()
  })

  describe('chatCompletion', () => {
    it('extracts system message and sends to Anthropic Messages API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '回覆' }],
        }),
      })

      const messages = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: '你好' },
      ]
      const result = await provider.chatCompletion(messages)

      expect(result).toBe('回覆')
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(callBody.system).toBe('You are helpful.')
      expect(callBody.messages).toEqual([{ role: 'user', content: '你好' }])
    })

    it('merges consecutive same-role messages', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '回覆' }],
        }),
      })

      const messages = [
        { role: 'system', content: 'Prompt A' },
        { role: 'system', content: 'Prompt B' },
        { role: 'user', content: '你好' },
      ]
      await provider.chatCompletion(messages)

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(callBody.system).toBe('Prompt A\n\nPrompt B')
    })

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      })

      await expect(
        provider.chatCompletion([{ role: 'user', content: '你好' }])
      ).rejects.toThrow('Anthropic chat failed: 400')
    })
  })

  describe('transcribeAudio', () => {
    it('falls back to OpenAI Whisper', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: '語音轉文字' }),
      })

      const result = await provider.transcribeAudio(new ArrayBuffer(8))

      expect(result).toBe('語音轉文字')
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://api.openai.com/v1/audio/transcriptions'
      )
    })
  })
})
