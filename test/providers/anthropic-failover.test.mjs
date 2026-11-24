import { describe, it, expect, jest, beforeEach } from '@jest/globals'

const mockFetch = jest.fn()
global.fetch = mockFetch

process.env.ANTHROPIC_API_KEY = 'test-ant-key'
process.env.CHAT_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001'
process.env.SUMMARY_MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001'

const { AnthropicProvider, BedrockBackup } = await import('../../lambda/providers/anthropic.mjs')

const reply = (text) => ({ content: [{ type: 'text', text }] })
const ok = (text) => ({ ok: true, status: 200, json: async () => reply(text) })
const failed = (status, type, message = 'details the API wrote for a human') => ({
  ok: false,
  status,
  json: async () => ({ type: 'error', error: { type, message } }),
})
const ask = [{ role: 'system', content: '你是無相界' }, { role: 'user', content: '你好' }]

describe('AnthropicProvider when Anthropic fails', () => {
  let backup

  beforeEach(() => {
    mockFetch.mockReset()
    backup = { send: jest.fn() }
  })

  it('names the failure by status and error type, never by the text the API wrote', async () => {
    mockFetch.mockResolvedValueOnce(failed(401, 'authentication_error'))
    const provider = new AnthropicProvider({ backup: null, retryPauseMs: 0 })

    const err = await provider.chatCompletion(ask).catch((e) => e)

    expect(err.message).toBe('Anthropic chat failed: 401 authentication_error')
    expect(err.status).toBe(401)
    expect(err.message).not.toContain('details the API wrote')
  })

  it('leaves out an error type it does not know', async () => {
    mockFetch.mockResolvedValueOnce(failed(418, 'something_new <script>'))
    const provider = new AnthropicProvider({ backup: null, retryPauseMs: 0 })

    await expect(provider.chatCompletion(ask)).rejects.toThrow(/^Anthropic chat failed: 418$/)
  })

  it('asks Anthropic once more when it was only overloaded, and answers', async () => {
    mockFetch.mockResolvedValueOnce(failed(529, 'overloaded_error')).mockResolvedValueOnce(ok('回覆'))
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    await expect(provider.chatCompletion(ask)).resolves.toEqual({ text: '回覆' })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(backup.send).not.toHaveBeenCalled()
  })

  it('asks once more when the network dropped', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(ok('回覆'))
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    await expect(provider.chatCompletion(ask)).resolves.toEqual({ text: '回覆' })
  })

  it('answers from the backup when Anthropic is still overloaded the second time', async () => {
    mockFetch.mockResolvedValue(failed(529, 'overloaded_error'))
    backup.send.mockResolvedValueOnce(reply('備援的回覆'))
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    await expect(provider.chatCompletion(ask)).resolves.toEqual({ text: '備援的回覆' })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [op, body] = backup.send.mock.calls[0]
    expect(op).toBe('chat')
    expect(body.system).toBe('你是無相界')
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }])
    expect(body).not.toHaveProperty('model')
  })

  it('gives the apology instead of the backup when Anthropic says the bot is over its rate limit', async () => {
    mockFetch.mockResolvedValueOnce(failed(429, 'rate_limit_error'))
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    await expect(provider.chatCompletion(ask)).rejects.toThrow('Anthropic chat failed: 429 rate_limit_error')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(backup.send).not.toHaveBeenCalled()
  })

  it('goes straight to the backup when Anthropic rejects the key, without asking again', async () => {
    mockFetch.mockResolvedValueOnce(failed(401, 'authentication_error'))
    backup.send.mockResolvedValueOnce(reply('備援的回覆'))
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    await expect(provider.chatCompletion(ask)).resolves.toEqual({ text: '備援的回覆' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('names both failures when the backup fails too', async () => {
    mockFetch.mockResolvedValueOnce(failed(400, 'invalid_request_error'))
    backup.send.mockRejectedValueOnce(Object.assign(new Error('Bedrock chat failed: 403 AccessDeniedException'), { status: 403 }))
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    const err = await provider.chatCompletion(ask).catch((e) => e)

    expect(err.message).toBe('Anthropic chat failed: 400 invalid_request_error; backup: Bedrock chat failed: 403 AccessDeniedException')
    expect(err.status).toBe(400)
  })

  it('stops at the deadline: no second try and no backup', async () => {
    const deadline = new AbortController()
    mockFetch.mockImplementationOnce(async () => {
      deadline.abort()
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    const err = await provider.chatCompletion(ask, { signal: deadline.signal }).catch((e) => e)

    expect(err.name).toBe('AbortError')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(backup.send).not.toHaveBeenCalled()
  })

  it('gives the backup its turn when Anthropic hangs instead of failing', async () => {
    mockFetch.mockImplementation((url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
    }))
    backup.send.mockResolvedValueOnce(reply('備援的回覆'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0, chatAttemptMs: 20 })

    await expect(provider.chatCompletion(ask, { signal: AbortSignal.timeout(5_000) })).resolves.toEqual({ text: '備援的回覆' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Provider fallback: Anthropic chat failed: no response -> Bedrock chat ok')
    warn.mockRestore()
  })

  it('logs that the backup answered, naming the failure and nothing the person said', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch.mockResolvedValueOnce(failed(401, 'authentication_error'))
    backup.send.mockResolvedValueOnce(reply('備援的回覆'))
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    await provider.chatCompletion(ask)

    expect(warn).toHaveBeenCalledWith('Provider fallback: Anthropic chat failed: 401 authentication_error -> Bedrock chat ok')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('你好')
    warn.mockRestore()
  })

  it('summarizes through the same path, so a summary survives Anthropic being down', async () => {
    mockFetch.mockResolvedValue(failed(500, 'api_error'))
    backup.send.mockResolvedValueOnce(reply('摘要'))
    const provider = new AnthropicProvider({ backup, retryPauseMs: 0 })

    await expect(provider.summarize(null, [{ role: 'user', content: '最近很累' }])).resolves.toBe('摘要')
    expect(backup.send.mock.calls[0][0]).toBe('summary')
  })

  it('gives a summary a deadline of its own', async () => {
    mockFetch.mockResolvedValueOnce(ok('摘要'))
    const provider = new AnthropicProvider({ backup: null, retryPauseMs: 0 })

    await provider.summarize(null, [{ role: 'user', content: '最近很累' }])

    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
})

describe('BedrockBackup', () => {
  it('sends the same request with the version Bedrock asks for, and reads the reply back', async () => {
    const client = { send: jest.fn().mockResolvedValueOnce({ body: new TextEncoder().encode(JSON.stringify(reply('備援'))) }) }
    const signal = new AbortController().signal

    const data = await new BedrockBackup('jp.anthropic.claude-haiku-4-5-20251001-v1:0', client).send('chat', { max_tokens: 1024, messages: [] }, signal)

    expect(data).toEqual(reply('備援'))
    const [command, options] = client.send.mock.calls[0]
    expect(command.input.modelId).toBe('jp.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(JSON.parse(command.input.body)).toEqual({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 1024, messages: [] })
    expect(options.abortSignal).toBe(signal)
  })

  it('names a failure by status and error name only', async () => {
    const denied = Object.assign(new Error('You do not have access, see https://example and your details'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
    })
    const client = { send: jest.fn().mockRejectedValueOnce(denied) }

    const err = await new BedrockBackup('model', client).send('chat', {}, undefined).catch((e) => e)

    expect(err.message).toBe('Bedrock chat failed: 403 AccessDeniedException')
    expect(err.status).toBe(403)
  })
})
