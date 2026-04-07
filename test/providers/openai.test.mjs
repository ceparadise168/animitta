import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const mockFetch = jest.fn()
global.fetch = mockFetch

process.env.OPENAI_API_KEY = 'test-key'
process.env.CHAT_MODEL_OPENAI = 'gpt-4.1-mini'
process.env.SUMMARY_MODEL_OPENAI = 'gpt-4.1-mini'

const { OpenAiProvider } = await import('../../lambda/providers/openai.mjs')

describe('OpenAiProvider', () => {
  let provider

  beforeEach(() => {
    provider = new OpenAiProvider()
    mockFetch.mockReset()
  })

  describe('chatCompletion', () => {
    it('sends messages and returns structured { text, suggestions }', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ text: '回覆內容', suggestions: ['A', 'B'] }) } }],
        }),
      })

      const result = await provider.chatCompletion([
        { role: 'user', content: '你好' },
      ])

      expect(result).toEqual({ text: '回覆內容', suggestions: ['A', 'B'] })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({ method: 'POST' })
      )
    })

    it('returns empty suggestions when none provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ text: '回覆', suggestions: [] }) } }],
        }),
      })

      const result = await provider.chatCompletion([
        { role: 'user', content: '你好' },
      ])

      expect(result).toEqual({ text: '回覆', suggestions: [] })
    })

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })

      await expect(
        provider.chatCompletion([{ role: 'user', content: '你好' }])
      ).rejects.toThrow('OpenAI chat failed: 500')
    })
  })

  describe('summarize', () => {
    it('sends summary prompt and returns compressed text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '壓縮摘要' } }],
        }),
      })

      const turns = [
        { role: 'user', content: '我很累' },
        { role: 'assistant', content: '辛苦了' },
      ]
      const result = await provider.summarize('舊摘要', turns)

      expect(result).toBe('壓縮摘要')
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(callBody.model).toBe('gpt-4.1-mini')
      expect(callBody.temperature).toBe(0.3)
    })
  })

  describe('transcribeAudio', () => {
    it('sends audio and returns transcript', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: '語音轉文字' }),
      })

      const audioBuffer = new ArrayBuffer(8)
      const result = await provider.transcribeAudio(audioBuffer)

      expect(result).toBe('語音轉文字')
    })
  })
})
