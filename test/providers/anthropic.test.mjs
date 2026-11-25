import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'

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
      const caller = new AbortController()

      await provider.chatCompletion([{ role: 'user', content: '你好' }], { signal: caller.signal })
      const requestSignal = mockFetch.mock.calls[0][1].signal
      caller.abort()

      expect(requestSignal.aborted).toBe(true)
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

  describe('a model for worries', () => {
    const answering = () => mockFetch.mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text: '回覆' }] }) })
    const sent = (call = 0) => JSON.parse(mockFetch.mock.calls[call][1].body)
    const withWorriesModel = () => {
      process.env.WORRIES_MODEL_ANTHROPIC = 'claude-sonnet-5-5'
      process.env.WORRIES_EFFORT_ANTHROPIC = 'high'
      return new AnthropicProvider()
    }

    afterEach(() => {
      delete process.env.WORRIES_MODEL_ANTHROPIC
      delete process.env.WORRIES_EFFORT_ANTHROPIC
    })

    it('answers worries, with its effort, and leaves the rest to the chat model', async () => {
      answering()
      const provider = withWorriesModel()

      await provider.chatCompletion([{ role: 'user', content: '最近很卡' }], { worries: true })
      await provider.chatCompletion([{ role: 'user', content: '今天天氣好' }])

      expect(provider.answersWorries).toBe(true)
      expect(sent(0)).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16000, output_config: { effort: 'high' } })
      expect(sent(0).temperature).toBeUndefined()
      expect(sent(1)).toMatchObject({ model: 'claude-haiku-4-5-20251001', temperature: 0.8 })
    })

    it('is the chat model itself when none is configured', async () => {
      answering()

      await provider.chatCompletion([{ role: 'user', content: '最近很卡' }], { worries: true })

      expect(provider.answersWorries).toBe(false)
      expect(sent().model).toBe('claude-haiku-4-5-20251001')
    })

    it('is not stood in for by the backup, which is the chat model elsewhere', async () => {
      const backup = { send: jest.fn() }
      process.env.WORRIES_MODEL_ANTHROPIC = 'claude-sonnet-5-5'
      const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })
      mockFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { type: 'not_found_error' } }) })

      await expect(provider.chatCompletion([{ role: 'user', content: '最近很卡' }], { worries: true })).rejects.toThrow('Anthropic chat failed: 404 not_found_error')
      expect(backup.send).not.toHaveBeenCalled()
    })
  })

  describe('what is the same for everyone', () => {
    it('goes first, marked so Anthropic may keep it, and what is said of one person follows', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: '回覆' }] }) })

      await provider.chatCompletion([
        { role: 'system', content: '提示詞', sameForEveryone: true },
        { role: 'system', content: '示範', sameForEveryone: true },
        { role: 'system', content: '這個人的摘要' },
        { role: 'user', content: '你好' },
      ])

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.system).toEqual([
        { type: 'text', text: '提示詞\n\n示範', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '\n\n這個人的摘要' },
      ])
      expect(body.messages).toEqual([{ role: 'user', content: '你好' }])
    })

    it('is the only block when nothing is said of the person', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: '回覆' }] }) })

      await provider.chatCompletion([{ role: 'system', content: '提示詞', sameForEveryone: true }, { role: 'user', content: '你好' }])

      expect(JSON.parse(mockFetch.mock.calls[0][1].body).system).toEqual([{ type: 'text', text: '提示詞', cache_control: { type: 'ephemeral' } }])
    })
  })

  describe('ask', () => {
    it('puts a short question to the chat model and gives back its word', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: '是' }] }) })

      const answer = await provider.ask('這句是不是二選一？')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(answer).toBe('是')
      expect(body).toEqual({ model: 'claude-haiku-4-5-20251001', max_tokens: 8, temperature: 0, messages: [{ role: 'user', content: '這句是不是二選一？' }] })
    })

    it('fails when the model does, so whoever asked can go on without the answer', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { type: 'invalid_request_error' } }) })

      await expect(provider.ask('這句是不是二選一？')).rejects.toThrow('Anthropic ask failed: 400 invalid_request_error')
    })
  })

  describe('summarize', () => {
    const turns = [
      { role: 'user', content: '今天又加班到快十點' },
      { role: 'assistant', content: '辛苦了，先好好休息' },
    ]

    async function sentRequest(existingSummary) {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: '摘要' }] }) })
      await provider.summarize(existingSummary, turns)
      return JSON.parse(mockFetch.mock.calls[0][1].body)
    }
    const promptOf = (request) => request.messages[0].content
    const between = (text, open, close) => text.slice(text.indexOf(open) + open.length, text.indexOf(close))

    it('puts the turns inside the transcript tags, labelled by speaker', async () => {
      const prompt = promptOf(await sentRequest('舊的摘要'))

      expect(between(prompt, '<要濃縮的對話>\n', '\n</要濃縮的對話>')).toBe('[使用者] 今天又加班到快十點\n[無相界] 辛苦了，先好好休息')
      expect(prompt).not.toMatch(/^(User|Assistant):/m)
    })

    it('puts the old summary inside its own tags', async () => {
      const prompt = promptOf(await sentRequest('使用者是一名軟體工程師'))

      expect(between(prompt, '<舊摘要>\n', '\n</舊摘要>')).toBe('使用者是一名軟體工程師')
    })

    it('leaves the old summary out when there is none', async () => {
      const prompt = promptOf(await sentRequest(null))

      expect(prompt).not.toContain('舊摘要')
    })

    it('asks for the summary alone after the transcript, so the model does not reply', async () => {
      const prompt = promptOf(await sentRequest('舊的摘要'))
      const closing = '請只輸出新的摘要本身。你不是對話裡的任何一方，不要回覆任何人，也不要接著寫對話。'

      expect(prompt.indexOf(closing)).toBeGreaterThan(prompt.indexOf('</要濃縮的對話>'))
      expect(prompt.endsWith(closing)).toBe(true)
    })

    it('keeps the summary request shape', async () => {
      const request = await sentRequest('舊的摘要')

      expect(request).toEqual({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        temperature: 0.3,
        messages: [{ role: 'user', content: expect.any(String) }],
      })
    })
  })
})
