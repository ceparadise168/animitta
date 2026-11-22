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

      expect(result).toEqual({ text: '回覆' })
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(callBody.system).toBe('You are helpful.')
      expect(callBody.messages).toEqual([{ role: 'user', content: '你好' }])
    })

    it('hands the abort signal to the request, so a stuck call can be given up on', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: '回覆' }] }) })
      const signal = AbortSignal.timeout(10_000)

      await provider.chatCompletion([{ role: 'user', content: '你好' }], { signal })

      expect(mockFetch.mock.calls[0][1].signal).toBe(signal)
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

    it('keeps the temperature-based request when no effort is configured', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: '回覆' }] }),
      })

      await provider.chatCompletion([
        { role: 'system', content: 'S' },
        { role: 'user', content: '你好' },
      ])

      expect(mockFetch.mock.calls[0][1].body).toBe(
        JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          temperature: 0.8,
          system: 'S',
          messages: [{ role: 'user', content: '你好' }],
        })
      )
    })

    it('sends effort instead of temperature when CHAT_EFFORT_ANTHROPIC is set', async () => {
      process.env.CHAT_EFFORT_ANTHROPIC = 'high'
      try {
        const effortProvider = new AnthropicProvider()
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ content: [{ type: 'text', text: '回覆' }] }),
        })

        await effortProvider.chatCompletion([{ role: 'user', content: '你好' }])

        const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
        expect(callBody.output_config).toEqual({ effort: 'high' })
        expect(callBody).not.toHaveProperty('temperature')
        expect(callBody.max_tokens).toBe(16000)
      } finally {
        delete process.env.CHAT_EFFORT_ANTHROPIC
      }
    })

    it('reads the reply from the text block after a thinking block', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: '回覆' },
          ],
        }),
      })

      const result = await provider.chatCompletion([{ role: 'user', content: '你好' }])

      expect(result).toEqual({ text: '回覆' })
    })

    it('throws when the model refuses instead of replying with nothing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'general_harms' },
          content: [],
        }),
      })

      await expect(
        provider.chatCompletion([{ role: 'user', content: '你好' }])
      ).rejects.toThrow('Anthropic chat refused: general_harms')
    })

    it('throws when thinking used up max_tokens before any text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          stop_reason: 'max_tokens',
          content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
        }),
      })

      await expect(
        provider.chatCompletion([{ role: 'user', content: '你好' }])
      ).rejects.toThrow('no text (stop_reason: max_tokens)')
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

})
